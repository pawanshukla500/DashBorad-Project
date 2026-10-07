#!/usr/bin/env bash
# Remote half of .github/workflows/deploy-hostinger.yml. The workflow pipes this
# file over SSH to the Hostinger VPS (`bash -s`) after uploading the source
# tarball and the generated .env next to it.
#
#   1. Record the rollback target: the running image if it is healthy,
#      otherwise reconcentral:latest (the last release that passed its checks).
#   2. Unpack the release; keep the previous release directory for rollback.
#   3. Build reconcentral:$IMAGE_TAG while the old container keeps serving.
#   4. pg_dump -Fc of paymentapp only, unless disk space is too low (abort).
#   5. Start the new container (it runs the startup migrations).
#   6. Health-check it. On failure, bring the previous image back with
#      --no-build and exit non-zero.
#   7. On success, point reconcentral:latest at the release and keep the last
#      $IMAGE_KEEP releases that passed their checks.
#
# The script keeps running if the SSH session goes away (job cancelled or timed
# out), so a started rollback still finishes; its full output is also written to
# $APP_ROOT/deploy-logs/.
#
# Required environment: IMAGE_TAG (the full 40-character commit SHA).
# Optional: SKIP_PREDEPLOY_BACKUP=true, ROLLBACK_DRILL=true and the overrides
# in the defaults block below (the overrides exist for the mocked test in
# scripts/deploy/test-hostinger-deploy.sh).
#
# Never enable `set -x` here: .env and the container environment hold secrets.
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/reconcentral}"
APP_DIR="$APP_ROOT/ReconCentral"
PREV_DIR="$APP_ROOT/ReconCentral.prev"
NEXT_DIR="$APP_ROOT/ReconCentral.next"
SOURCE_TARBALL="$APP_ROOT/reconcentral-source.tar.gz"
UPLOADED_ENV="$APP_ROOT/hostinger.env"
HPANEL_LINK="${HPANEL_LINK:-/docker/reconcentral}"
DEPLOY_LOG_DIR="$APP_ROOT/deploy-logs"
GOOD_RELEASES_FILE="$APP_ROOT/good-releases"

COMPOSE_PROJECT=reconcentral
COMPOSE_FILE=docker-compose.production.yml
APP_CONTAINER=ReconCentral
IMAGE_REPO=reconcentral
IMAGE_KEEP="${IMAGE_KEEP:-3}"

# The PostgreSQL container is shared by several databases. Only paymentapp is
# dumped here, and nothing in this script restarts or reconfigures Postgres.
PG_CONTAINER="${PG_CONTAINER:-postgresql-6k6a-postgresql-1}"
BACKUP_DB=paymentapp
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/reconcentral-predeploy}"
BACKUP_KEEP="${BACKUP_KEEP:-5}"
# Free space required on top of the database's on-disk size before dumping.
BACKUP_HEADROOM_MB="${BACKUP_HEADROOM_MB:-2048}"

SKIP_PREDEPLOY_BACKUP="${SKIP_PREDEPLOY_BACKUP:-false}"
ROLLBACK_DRILL="${ROLLBACK_DRILL:-false}"
HEALTH_GRACE_SECONDS="${HEALTH_GRACE_SECONDS:-10}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-15}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"
# Upper bound for one probe, so a hung app cannot outlast the job timeout.
PROBE_TIMEOUT="${PROBE_TIMEOUT:-20}"

PREV_IMAGE_ID=""
PREV_TAG=""
MOVED_PREVIOUS=0
# Set once rollback starts changing anything (directories, tags, container).
ROLLBACK_SWITCHED=0
RUN_STAMP=""

log() { printf '%s\n' "$*"; }
# ::error:: / ::warning:: lines become annotations on the GitHub Actions run.
fail_note() { printf '::error::%s\n' "$*"; }

compose() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file .env "$@"
}

image_id() { docker image inspect -f '{{.Id}}' "$1" 2> /dev/null; }

# Deletes all but the newest $2 files matching $3 in directory $1.
keep_newest() {
  local old
  find "$1" -maxdepth 1 -type f -name "$3" -printf '%T@ %p\n' \
    | sort -rn \
    | tail -n +"$(($2 + 1))" \
    | cut -d' ' -f2- \
    | while IFS= read -r old; do
        rm -f -- "$old"
        log "Removed old file $(basename "$old")"
      done
}

# Mirror all output into a root-only log on the VPS. If the SSH session drops,
# ignore SIGHUP and let tee keep writing to the file after its stdout (the SSH
# channel) is gone (-p), so the script is never killed between `up` and a
# rollback.
start_deploy_log() {
  mkdir -p "$DEPLOY_LOG_DIR"
  chmod 700 "$DEPLOY_LOG_DIR"
  trap '' HUP
  exec > >(umask 077 && exec tee -p -a "$DEPLOY_LOG_DIR/${RUN_STAMP}_${IMAGE_TAG:0:12}.deploy.log") 2>&1
  keep_newest "$DEPLOY_LOG_DIR" 20 '*.deploy.log' > /dev/null
}

# A deploy whose SSH session dropped can still be running; wait for it.
acquire_deploy_lock() {
  if ! command -v flock > /dev/null 2>&1; then
    return 0
  fi
  exec 9> "$APP_ROOT/.deploy.lock"
  if ! flock -w 900 9; then
    fail_note "Another deploy has held $APP_ROOT/.deploy.lock for 15 minutes; not deploying."
    exit 1
  fi
}

record_previous_image() {
  local running_id="" ref="" health="" latest_id candidate="" short

  if running_id="$(docker inspect -f '{{.Image}}' "$APP_CONTAINER" 2> /dev/null)"; then
    ref="$(docker inspect -f '{{.Config.Image}}' "$APP_CONTAINER")"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$APP_CONTAINER")"
  else
    running_id=""
  fi
  latest_id="$(image_id "$IMAGE_REPO:latest" || true)"

  if [ -n "$running_id" ] && { [ "$health" = "healthy" ] || [ -z "$latest_id" ]; }; then
    PREV_IMAGE_ID="$running_id"
  elif [ -n "$latest_id" ]; then
    # Never roll back onto a container that is already broken (or gone).
    log "The running container is ${health:-absent}; using $IMAGE_REPO:latest (last release that passed its checks) as the rollback target."
    PREV_IMAGE_ID="$latest_id"
    ref="$IMAGE_REPO:latest"
  else
    log "No running container and no $IMAGE_REPO:latest; automatic rollback is unavailable for this deploy."
    return 0
  fi

  case "$ref" in
    "$IMAGE_REPO":*) candidate="${ref#"$IMAGE_REPO":}" ;;
  esac
  # Reuse the commit tag only if it is immutable (a commit SHA), is not about
  # to be rebuilt by this deploy, and still names the target image. Anything
  # else (the old single `latest` tag, a redeploy of the same commit) is pinned
  # under a tag derived from the image ID so a rebuild cannot move it.
  if [[ "$candidate" =~ ^[0-9a-f]{40}$ && "$candidate" != "$IMAGE_TAG" ]] \
    && [[ "$(image_id "$IMAGE_REPO:$candidate" || true)" == "$PREV_IMAGE_ID" ]]; then
    PREV_TAG="$candidate"
  else
    short="${PREV_IMAGE_ID#sha256:}"
    PREV_TAG="rollback-${short:0:12}"
    docker tag "$PREV_IMAGE_ID" "$IMAGE_REPO:$PREV_TAG"
  fi
  log "Rollback target: $IMAGE_REPO:$PREV_TAG ($ref, $PREV_IMAGE_ID)"
}

# Called from `if !`, where errexit is off, so every step is chained.
stage_release() {
  rm -rf "$PREV_DIR" "$NEXT_DIR" || return 1
  if [ -d "$APP_DIR" ]; then
    mv "$APP_DIR" "$PREV_DIR" || return 1
    MOVED_PREVIOUS=1
  fi
  # Root-owned files: the archive carries the CI runner's uid, and root later
  # runs the compose file from this directory.
  mkdir -p "$APP_DIR" \
    && tar --no-same-owner -xzf "$SOURCE_TARBALL" -C "$APP_DIR" \
    && mv "$UPLOADED_ENV" "$APP_DIR/.env" \
    && chmod 600 "$APP_DIR/.env" \
    && ln -sf "$COMPOSE_FILE" "$APP_DIR/docker-compose.yml"
}

# Put the previous release directory (compose file + .env the running
# container was created from) back in place. With an argument, the release
# being replaced is kept at that path instead of deleted.
restore_previous_source() {
  local keep_as="${1:-}"
  if [ "$MOVED_PREVIOUS" -ne 1 ]; then
    return 0
  fi
  cd "$APP_ROOT" || return 1
  if [ -n "$keep_as" ]; then
    rm -rf "$keep_as" && mv "$APP_DIR" "$keep_as" || return 1
  else
    rm -rf "$APP_DIR" || return 1
  fi
  mv "$PREV_DIR" "$APP_DIR" || return 1
  MOVED_PREVIOUS=0
}

database_role() {
  if [ -n "${PG_BACKUP_ROLE:-}" ]; then
    printf '%s' "$PG_BACKUP_ROLE"
    return 0
  fi
  # User name from DATABASE_URL; the password is never read. pg_dump connects
  # over the Postgres container's local socket, which uses trust auth.
  sed -n -E 's#^DATABASE_URL=[A-Za-z0-9+.-]+://([^:@/]+)[:@].*#\1#p' "$APP_DIR/.env" | head -n 1
}

predeploy_backup() {
  local role db_bytes avail_kb need_kb file partial started old_umask size_bytes

  if [ "$SKIP_PREDEPLOY_BACKUP" = "true" ]; then
    printf '::warning::%s\n' "Pre-deploy backup of $BACKUP_DB skipped (skip_predeploy_backup input). The latest nightly dump is the only restore point for this deploy."
    return 0
  fi

  if [ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2> /dev/null || true)" != "true" ]; then
    fail_note "PostgreSQL container $PG_CONTAINER is not running; cannot take the pre-deploy backup."
    return 1
  fi

  role="$(database_role)"
  if [ -z "$role" ]; then
    fail_note "Could not read the database user from DATABASE_URL in .env; set PG_BACKUP_ROLE."
    return 1
  fi

  if ! { mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"; }; then
    fail_note "Cannot create $BACKUP_DIR."
    return 1
  fi
  # Leftovers from an interrupted run are incomplete by definition.
  rm -f "$BACKUP_DIR"/*.partial

  if ! db_bytes="$(docker exec "$PG_CONTAINER" psql -w -X -U "$role" -d "$BACKUP_DB" -Atc 'SELECT pg_database_size(current_database())')" \
    || ! [[ "$db_bytes" =~ ^[0-9]+$ ]]; then
    fail_note "Could not read the size of $BACKUP_DB; aborting before the new container starts."
    return 1
  fi
  avail_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')"
  if ! [[ "$avail_kb" =~ ^[0-9]+$ ]]; then
    fail_note "Could not read free disk space for $BACKUP_DIR; aborting before the new container starts."
    return 1
  fi
  need_kb=$((db_bytes / 1024 + BACKUP_HEADROOM_MB * 1024))
  if ((avail_kb < need_kb)); then
    fail_note "Low disk space: $((avail_kb / 1024)) MB free for $BACKUP_DIR, need $((need_kb / 1024)) MB ($BACKUP_DB size + ${BACKUP_HEADROOM_MB} MB headroom). Deploy aborted before the new container started; production is unchanged. Free space or re-run with skip_predeploy_backup."
    return 1
  fi

  file="$BACKUP_DIR/${BACKUP_DB}_${RUN_STAMP}_${IMAGE_TAG:0:12}.dump"
  partial="$file.partial"
  log "Pre-deploy backup: pg_dump -Fc $BACKUP_DB ($((db_bytes / 1048576)) MB on disk, $((avail_kb / 1024)) MB free)..."
  started=$SECONDS
  old_umask="$(umask)"
  umask 077
  if ! docker exec "$PG_CONTAINER" pg_dump -w -U "$role" -d "$BACKUP_DB" -Fc --lock-wait-timeout=60s > "$partial"; then
    umask "$old_umask"
    rm -f "$partial"
    fail_note "pg_dump of $BACKUP_DB failed; deploy aborted before the new container started. Production is unchanged."
    return 1
  fi
  umask "$old_umask"

  # Read the whole archive (every data block), not just its table of
  # contents, so a truncated file is caught here rather than at restore time.
  if [ ! -s "$partial" ] || ! docker exec -i "$PG_CONTAINER" pg_restore -f /dev/null < "$partial"; then
    rm -f "$partial"
    fail_note "Pre-deploy backup of $BACKUP_DB is not a complete archive; deploy aborted. Production is unchanged."
    return 1
  fi
  if ! mv "$partial" "$file"; then
    rm -f "$partial"
    fail_note "Could not finalize the pre-deploy backup; deploy aborted. Production is unchanged."
    return 1
  fi
  size_bytes="$(stat -c %s "$file" 2> /dev/null || echo 0)"
  log "Pre-deploy backup written: $file ($((size_bytes / 1048576)) MB, $((SECONDS - started))s)"
  keep_newest "$BACKUP_DIR" "$BACKUP_KEEP" "${BACKUP_DB}_*.dump"
}

check_database_route() {
  timeout "$PROBE_TIMEOUT" docker exec "$APP_CONTAINER" node -e "const dns=require('node:dns').promises; const raw=process.env.DATABASE_URL || ''; const host=new URL(raw).hostname; const privateHost=host==='localhost'||host==='127.0.0.1'||host==='postgres'||host==='host.docker.internal'||host.endsWith('.docker.internal')||/^10\\./.test(host)||/^192\\.168\\./.test(host)||/^172\\.(1[6-9]|2[0-9]|3[0-1])\\./.test(host); if(!privateHost){console.error('DATABASE_URL host is not private for same-VPS deployment'); process.exit(1);} dns.lookup(host).then(({address})=>console.log(JSON.stringify({databaseHost:host,resolved:address}))).catch(error=>{console.error(error.message); process.exit(1);});"
}

check_container_health() {
  timeout "$PROBE_TIMEOUT" docker exec "$APP_CONTAINER" node -e "fetch('http://127.0.0.1:3001/health',{signal:AbortSignal.timeout(10000)}).then(async r=>{const body=await r.json().catch(()=>({})); const database=body.database || {}; if(!r.ok || !body.dbConnected || database.schemaReady !== true || database.transport?.productionReady !== true){console.error(JSON.stringify({status:r.status,dbConnected:body.dbConnected,schemaReady:database.schemaReady,transport:database.transport,pool:database.pool})); process.exit(1);} console.log(JSON.stringify({status:r.status,dbConnected:body.dbConnected,schemaReady:database.schemaReady,transport:database.transport,pool:database.pool}));}).catch(error=>{console.error(error.message); process.exit(1);})"
}

# Returns non-zero instead of exiting so the caller can roll back. errexit is
# suspended inside functions called from `if`, so every step is checked here.
verify_release() {
  local env_file="$1" healthy=0 public_healthy=0 app_domain i

  log "Verifying private database route from inside the app container..."
  if ! check_database_route; then
    log "Private database route check failed."
    return 1
  fi

  log "Verifying ReconCentral container health..."
  sleep "$HEALTH_GRACE_SECONDS"
  docker ps --filter "name=$APP_CONTAINER" || true

  for ((i = 1; i <= HEALTH_ATTEMPTS; i++)); do
    if check_container_health; then
      log ""
      log "ReconCentral is live and healthy!"
      healthy=1
      break
    fi
    log "Waiting for ReconCentral to report healthy ($i/$HEALTH_ATTEMPTS)..."
    sleep "$HEALTH_INTERVAL"
  done
  if [ "$healthy" -ne 1 ]; then
    log "ReconCentral did not become database-ready in time."
    return 1
  fi

  app_domain="$(grep -E '^APP_DOMAIN=' "$env_file" | cut -d= -f2- || true)"
  if [ -n "$app_domain" ]; then
    for i in {1..6}; do
      if curl -fsS --max-time 15 "https://${app_domain}/health" > /dev/null; then
        public_healthy=1
        break
      fi
      log "Waiting for public HTTPS health route ($i/6)..."
      sleep 5
    done
    if [ "$public_healthy" -ne 1 ]; then
      log "Public HTTPS health route did not become healthy."
      return 1
    fi
  fi
}

# Application logs can contain customer data and DB error details, and the
# repository's Actions logs are public, so they stay on the VPS (root-only).
save_failed_release_logs() {
  local log_file="$DEPLOY_LOG_DIR/${RUN_STAMP}_${IMAGE_TAG:0:12}.app.log"
  if (umask 077 && docker logs "$APP_CONTAINER" --tail=500 > "$log_file" 2>&1); then
    log "Logs of the failed release saved on the VPS: $log_file"
  else
    log "Could not save the failed container's logs (container missing?)."
  fi
  keep_newest "$DEPLOY_LOG_DIR" 10 '*.app.log' > /dev/null
}

# Bring the rollback target back. With an argument, the failed release
# directory is kept at that path (the drill needs it to roll forward).
rollback() {
  local keep_failed_as="${1:-}" old_latest
  if [ -z "$PREV_IMAGE_ID" ]; then
    fail_note "No rollback target was recorded, so there is nothing to roll back to."
    return 1
  fi
  if ! docker image inspect "$IMAGE_REPO:$PREV_TAG" > /dev/null 2>&1; then
    fail_note "Rollback image $IMAGE_REPO:$PREV_TAG no longer exists; restore it manually (see docs/HOSTINGER_DEPLOY.md)."
    return 1
  fi

  log "Rolling back to $IMAGE_REPO:$PREV_TAG ..."
  # The restored release brings back the .env its container was created with.
  # Compare silently (never print values) so a rotated secret is not reverted
  # without anyone noticing.
  if [ "$MOVED_PREVIOUS" -eq 1 ] && [ -f "$PREV_DIR/.env" ] && ! cmp -s "$PREV_DIR/.env" "$APP_DIR/.env"; then
    printf '::warning::%s\n' "The rolled-back release uses its previous .env, which differs from the one just uploaded (e.g. a rotated secret). Deploy a fixed commit to apply the new values."
  fi
  ROLLBACK_SWITCHED=1
  if ! restore_previous_source "$keep_failed_as"; then
    fail_note "Could not restore the previous release directory."
    return 1
  fi
  # A pre-rollout compose file without ${IMAGE_TAG} resolves to `latest`, so
  # point it at the rollback target; put it back if the rollback fails.
  old_latest="$(image_id "$IMAGE_REPO:latest" || true)"
  if ! docker tag "$IMAGE_REPO:$PREV_TAG" "$IMAGE_REPO:latest" || ! cd "$APP_DIR"; then
    fail_note "Could not prepare the rollback."
    return 1
  fi
  if ! IMAGE_TAG="$PREV_TAG" compose up -d --no-build --force-recreate --remove-orphans; then
    fail_note "docker compose could not start $IMAGE_REPO:$PREV_TAG during rollback."
    [ -z "$old_latest" ] || docker tag "$old_latest" "$IMAGE_REPO:latest" || true
    return 1
  fi
  if ! verify_release "$APP_DIR/.env"; then
    fail_note "Rolled back to $IMAGE_REPO:$PREV_TAG but it is not healthy either."
    [ -z "$old_latest" ] || docker tag "$old_latest" "$IMAGE_REPO:latest" || true
    return 1
  fi
}

# Drill only: the rollback target turned out to be unhealthy, so return to the
# release that just passed its checks (kept in $NEXT_DIR by rollback).
roll_forward() {
  log "Rolling forward to $IMAGE_REPO:$IMAGE_TAG ..."
  cd "$APP_ROOT" \
    && rm -rf "$PREV_DIR" \
    && mv "$APP_DIR" "$PREV_DIR" \
    && mv "$NEXT_DIR" "$APP_DIR" \
    && cd "$APP_DIR" \
    && docker tag "$IMAGE_REPO:$IMAGE_TAG" "$IMAGE_REPO:latest" \
    && compose up -d --no-build --force-recreate --remove-orphans \
    && verify_release "$APP_DIR/.env"
}

record_good_release() {
  printf '%s\n' "$IMAGE_TAG" >> "$GOOD_RELEASES_FILE"
  tail -n 50 "$GOOD_RELEASES_FILE" > "$GOOD_RELEASES_FILE.tmp" && mv "$GOOD_RELEASES_FILE.tmp" "$GOOD_RELEASES_FILE"
}

# Keep the newest $IMAGE_KEEP releases that passed their checks, plus the
# running, new, `latest` and rollback-target images. Failed builds go at the
# next successful deploy (their logs stay in $DEPLOY_LOG_DIR). Only commit-SHA
# and rollback-* tags are managed; other images on this shared host are never
# touched.
prune_release_images() {
  local id tag good=0
  local -A keep=() counted=()

  for id in \
    "$(docker inspect -f '{{.Image}}' "$APP_CONTAINER" 2> /dev/null || true)" \
    "$(image_id "$IMAGE_REPO:$IMAGE_TAG" || true)" \
    "$(image_id "$IMAGE_REPO:latest" || true)" \
    "$PREV_IMAGE_ID"; do
    if [ -n "$id" ]; then keep[$id]=1; fi
  done

  if [ -f "$GOOD_RELEASES_FILE" ]; then
    while IFS= read -r tag; do
      if ((good >= IMAGE_KEEP)); then break; fi
      id="$(image_id "$IMAGE_REPO:$tag")" || continue
      if [ -z "${counted[$id]+x}" ]; then
        counted[$id]=1
        keep[$id]=1
        good=$((good + 1))
      fi
    done < <(tac "$GOOD_RELEASES_FILE")
  fi

  while IFS= read -r tag; do
    id="$(image_id "$IMAGE_REPO:$tag")" || continue
    if [ -z "${keep[$id]+x}" ]; then
      if docker image rm "$IMAGE_REPO:$tag" > /dev/null; then
        log "Removed old release image $IMAGE_REPO:$tag"
      else
        log "Could not remove $IMAGE_REPO:$tag (still referenced?); leaving it."
      fi
    fi
  done < <(docker image ls "$IMAGE_REPO" --format '{{.Tag}}' | { grep -E '^([0-9a-f]{40}|rollback-[0-9a-f]{12})$' || true; })
}

finish_success() {
  docker tag "$IMAGE_REPO:$IMAGE_TAG" "$IMAGE_REPO:latest"
  rm -rf "$PREV_DIR" "$NEXT_DIR"
  record_good_release
  prune_release_images || log "Warning: image retention failed; old images were left in place."
}

main() {
  if ! [[ "${IMAGE_TAG:-}" =~ ^[0-9a-f]{40}$ ]]; then
    fail_note "IMAGE_TAG must be the full 40-character commit SHA."
    exit 1
  fi
  export IMAGE_TAG
  RUN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

  cd "$APP_ROOT" || exit 1
  if [ ! -f "$SOURCE_TARBALL" ] || [ ! -f "$UPLOADED_ENV" ]; then
    fail_note "Release bundle or environment file missing in $APP_ROOT."
    exit 1
  fi
  # First, so the secrets file is private even if a later step aborts.
  chmod 600 "$UPLOADED_ENV"

  start_deploy_log
  acquire_deploy_lock
  log "Deploying $IMAGE_REPO:$IMAGE_TAG"

  record_previous_image
  if ! stage_release; then
    restore_previous_source || true
    fail_note "Could not unpack the release (disk full?). Production is unchanged."
    exit 1
  fi

  # Keep public traffic on Traefik/HTTPS only. The API container is
  # reachable to Traefik through Docker's shared_infra network.
  ufw delete allow 3001/tcp || true

  # Remove old legacy collision folder if present
  rm -rf "$APP_ROOT/app"

  cd "$APP_DIR" || exit 1
  log "Building $IMAGE_REPO:$IMAGE_TAG (the current container keeps serving)..."
  if ! compose build; then
    restore_previous_source
    fail_note "Image build failed. Production is unchanged."
    exit 1
  fi

  if ! predeploy_backup; then
    restore_previous_source
    exit 1
  fi

  # Nothing below may abort the script before the rollback decision.
  log "Deploying ReconCentral container via docker compose with project name $COMPOSE_PROJECT..."
  local release_ok=1
  if ! compose up -d --no-build --remove-orphans; then
    log "docker compose up failed for $IMAGE_REPO:$IMAGE_TAG."
    release_ok=0
  fi

  # Symlink to /docker/reconcentral for native Hostinger Docker Manager hPanel
  # detection. Cosmetic, so it must never abort the script.
  if ! { mkdir -p "$(dirname "$HPANEL_LINK")" && ln -sfn "$APP_DIR" "$HPANEL_LINK"; }; then
    log "Warning: could not update $HPANEL_LINK; continuing."
  fi

  if [ "$release_ok" -eq 1 ] && ! verify_release "$APP_DIR/.env"; then
    release_ok=0
  fi

  if [ "$release_ok" -ne 1 ]; then
    save_failed_release_logs || true
    if rollback; then
      fail_note "Release $IMAGE_TAG failed verification. Rolled back to $IMAGE_REPO:$PREV_TAG, which is healthy."
    else
      fail_note "Release $IMAGE_TAG failed verification and the rollback did not complete. Production needs manual attention (docs/HOSTINGER_DEPLOY.md)."
    fi
    exit 1
  fi

  if [ "$ROLLBACK_DRILL" = "true" ]; then
    printf '::notice::%s\n' "Rollback drill: $IMAGE_REPO:$IMAGE_TAG passed its checks; rolling back to $IMAGE_REPO:$PREV_TAG on purpose."
    if rollback "$NEXT_DIR"; then
      rm -rf "$NEXT_DIR"
      printf '::notice::%s\n' "Rollback drill passed: production is running $IMAGE_REPO:$PREV_TAG and is healthy."
      exit 0
    fi
    if [ "$ROLLBACK_SWITCHED" -eq 0 ]; then
      # rollback stopped before touching anything (no target, image gone):
      # production is still on the release that just passed its checks.
      finish_success
      fail_note "Rollback drill could not start a rollback (see above). Production stays on $IMAGE_REPO:$IMAGE_TAG, which is healthy."
    elif [ -d "$NEXT_DIR" ] && roll_forward; then
      finish_success
      fail_note "Rollback drill failed: $IMAGE_REPO:$PREV_TAG could not be brought back healthy. Production rolled forward to $IMAGE_REPO:$IMAGE_TAG and is healthy."
    else
      fail_note "Rollback drill failed and production could not return to $IMAGE_REPO:$IMAGE_TAG. Manual attention needed (docs/HOSTINGER_DEPLOY.md)."
    fi
    exit 1
  fi

  finish_success
  log "Deployed $IMAGE_REPO:$IMAGE_TAG."
}

# Called on the last line so bash has read the whole script from stdin before
# any command runs (nothing below can swallow the rest of the script).
main "$@"
