#!/usr/bin/env bash
# Remote half of .github/workflows/deploy-hostinger.yml. The workflow pipes this
# file over SSH to the Hostinger VPS (`bash -s`) after uploading the source
# tarball and the generated .env next to it.
#
#   1. Record the image the ReconCentral container is running now.
#   2. Unpack the release; keep the previous release directory for rollback.
#   3. Build reconcentral:$IMAGE_TAG while the old container keeps serving.
#   4. pg_dump -Fc of paymentapp only, unless disk space is too low (abort).
#   5. Start the new container (it runs the startup migrations).
#   6. Health-check it. On failure, bring the previous image back with
#      --no-build and exit non-zero.
#   7. On success, point reconcentral:latest at the release and keep the last
#      $IMAGE_KEEP release images.
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
SOURCE_TARBALL="$APP_ROOT/reconcentral-source.tar.gz"
UPLOADED_ENV="$APP_ROOT/hostinger.env"
HPANEL_LINK="${HPANEL_LINK:-/docker/reconcentral}"

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

PREV_IMAGE_ID=""
PREV_TAG=""

log() { printf '%s\n' "$*"; }
# ::error:: / ::warning:: lines become annotations on the GitHub Actions run.
fail_note() { printf '::error::%s\n' "$*"; }

compose() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file .env "$@"
}

record_previous_image() {
  local ref candidate="" short
  if ! PREV_IMAGE_ID="$(docker inspect -f '{{.Image}}' "$APP_CONTAINER" 2>/dev/null)"; then
    PREV_IMAGE_ID=""
    log "No existing $APP_CONTAINER container; automatic rollback is unavailable for this deploy."
    return 0
  fi
  ref="$(docker inspect -f '{{.Config.Image}}' "$APP_CONTAINER")"
  case "$ref" in
    "$IMAGE_REPO":*) candidate="${ref#"$IMAGE_REPO":}" ;;
  esac

  # Reuse the running commit tag only if it is immutable (a commit SHA), is not
  # about to be rebuilt by this deploy, and still names the running image.
  # Anything else (the old single `latest` tag, a redeploy of the same commit)
  # is pinned under a tag derived from the image ID so a rebuild cannot move it.
  if [[ "$candidate" =~ ^[0-9a-f]{40}$ && "$candidate" != "$IMAGE_TAG" ]] \
    && [[ "$(docker image inspect -f '{{.Id}}' "$IMAGE_REPO:$candidate" 2>/dev/null || true)" == "$PREV_IMAGE_ID" ]]; then
    PREV_TAG="$candidate"
  else
    short="${PREV_IMAGE_ID#sha256:}"
    PREV_TAG="rollback-${short:0:12}"
    docker tag "$PREV_IMAGE_ID" "$IMAGE_REPO:$PREV_TAG"
  fi
  log "Previously running image: $ref ($PREV_IMAGE_ID), rollback tag $IMAGE_REPO:$PREV_TAG"
}

stage_release() {
  rm -rf "$PREV_DIR"
  if [ -d "$APP_DIR" ]; then
    mv "$APP_DIR" "$PREV_DIR"
  fi
  mkdir -p "$APP_DIR"
  tar -xzf "$SOURCE_TARBALL" -C "$APP_DIR"
  mv "$UPLOADED_ENV" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  ln -sf "$COMPOSE_FILE" "$APP_DIR/docker-compose.yml"
}

# Put the previous release directory (compose file + .env the running
# container was created from) back in place.
restore_previous_source() {
  if [ -d "$PREV_DIR" ]; then
    rm -rf "$APP_DIR"
    mv "$PREV_DIR" "$APP_DIR"
  fi
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

prune_old_backups() {
  local old
  find "$BACKUP_DIR" -maxdepth 1 -type f -name "${BACKUP_DB}_*.dump" -printf '%T@ %p\n' \
    | sort -rn \
    | tail -n +"$((BACKUP_KEEP + 1))" \
    | cut -d' ' -f2- \
    | while IFS= read -r old; do
        rm -f -- "$old"
        log "Removed old pre-deploy backup $(basename "$old")"
      done
}

predeploy_backup() {
  local role db_bytes avail_kb need_kb stamp file partial started old_umask size_mb

  if [ "$SKIP_PREDEPLOY_BACKUP" = "true" ]; then
    printf '::warning::%s\n' "Pre-deploy backup of $BACKUP_DB skipped (skip_predeploy_backup input). The latest nightly dump is the only restore point for this deploy."
    return 0
  fi

  if [ "$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null || true)" != "true" ]; then
    fail_note "PostgreSQL container $PG_CONTAINER is not running; cannot take the pre-deploy backup."
    return 1
  fi

  role="$(database_role)"
  if [ -z "$role" ]; then
    fail_note "Could not read the database user from DATABASE_URL in .env; set PG_BACKUP_ROLE."
    return 1
  fi

  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
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

  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  file="$BACKUP_DIR/${BACKUP_DB}_${stamp}_${IMAGE_TAG:0:12}.dump"
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

  # Reading the archive's table of contents proves the file is a complete,
  # restorable custom-format header written by the same pg_dump version.
  if [ ! -s "$partial" ] || ! docker exec -i "$PG_CONTAINER" pg_restore --list < "$partial" > /dev/null; then
    rm -f "$partial"
    fail_note "Pre-deploy backup of $BACKUP_DB is not a readable archive; deploy aborted. Production is unchanged."
    return 1
  fi
  mv "$partial" "$file"
  size_mb=$(( $(stat -c %s "$file") / 1048576 ))
  log "Pre-deploy backup written: $file (${size_mb} MB, $((SECONDS - started))s)"
  prune_old_backups
}

check_database_route() {
  docker exec "$APP_CONTAINER" node -e "const dns=require('node:dns').promises; const raw=process.env.DATABASE_URL || ''; const host=new URL(raw).hostname; const privateHost=host==='localhost'||host==='127.0.0.1'||host==='postgres'||host==='host.docker.internal'||host.endsWith('.docker.internal')||/^10\\./.test(host)||/^192\\.168\\./.test(host)||/^172\\.(1[6-9]|2[0-9]|3[0-1])\\./.test(host); if(!privateHost){console.error('DATABASE_URL host is not private for same-VPS deployment'); process.exit(1);} dns.lookup(host).then(({address})=>console.log(JSON.stringify({databaseHost:host,resolved:address}))).catch(error=>{console.error(error.message); process.exit(1);});"
}

check_container_health() {
  docker exec "$APP_CONTAINER" node -e "fetch('http://127.0.0.1:3001/health').then(async r=>{const body=await r.json().catch(()=>({})); const database=body.database || {}; if(!r.ok || !body.dbConnected || database.schemaReady !== true || database.transport?.productionReady !== true){console.error(JSON.stringify({status:r.status,dbConnected:body.dbConnected,schemaReady:database.schemaReady,transport:database.transport,pool:database.pool})); process.exit(1);} console.log(JSON.stringify({status:r.status,dbConnected:body.dbConnected,schemaReady:database.schemaReady,transport:database.transport,pool:database.pool}));}).catch(error=>{console.error(error.message); process.exit(1);})"
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
      if curl -fsS "https://${app_domain}/health" > /dev/null; then
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

rollback() {
  if [ -z "$PREV_IMAGE_ID" ]; then
    fail_note "No previously running image was recorded, so there is nothing to roll back to."
    return 1
  fi
  if ! docker image inspect "$IMAGE_REPO:$PREV_TAG" > /dev/null 2>&1; then
    fail_note "Rollback image $IMAGE_REPO:$PREV_TAG no longer exists; restore it manually (see docs/HOSTINGER_DEPLOY.md)."
    return 1
  fi

  log "Rolling back to $IMAGE_REPO:$PREV_TAG ..."
  restore_previous_source
  # `latest` means "last known good"; a pre-rollout compose file without
  # ${IMAGE_TAG} also resolves to it.
  docker tag "$IMAGE_REPO:$PREV_TAG" "$IMAGE_REPO:latest"
  cd "$APP_DIR"
  if ! IMAGE_TAG="$PREV_TAG" compose up -d --no-build --force-recreate --remove-orphans; then
    fail_note "docker compose could not start $IMAGE_REPO:$PREV_TAG during rollback."
    return 1
  fi
  if ! verify_release "$APP_DIR/.env"; then
    fail_note "Rolled back to $IMAGE_REPO:$PREV_TAG but it is not healthy either. Manual intervention needed."
    return 1
  fi
}

prune_release_images() {
  local running_id new_id latest_id created id tag kept=0
  local -A seen=() keep=()

  running_id="$(docker inspect -f '{{.Image}}' "$APP_CONTAINER" 2>/dev/null || true)"
  new_id="$(docker image inspect -f '{{.Id}}' "$IMAGE_REPO:$IMAGE_TAG" 2>/dev/null || true)"
  latest_id="$(docker image inspect -f '{{.Id}}' "$IMAGE_REPO:latest" 2>/dev/null || true)"

  # Newest first, one line per release tag. Only commit-SHA and rollback-*
  # tags are managed; other images on this shared host are never touched.
  while read -r created id tag; do
    if [ -z "${seen[$id]+x}" ]; then
      seen[$id]=1
      if ((kept < IMAGE_KEEP)) || [[ "$id" == "$running_id" || "$id" == "$new_id" || "$id" == "$latest_id" ]]; then
        keep[$id]=1
        kept=$((kept + 1))
      fi
    fi
    if [ -z "${keep[$id]+x}" ]; then
      if docker image rm "$IMAGE_REPO:$tag" > /dev/null; then
        log "Removed old release image $IMAGE_REPO:$tag ($created)"
      else
        log "Could not remove $IMAGE_REPO:$tag (still referenced?); leaving it."
      fi
    fi
  done < <(
    docker image ls "$IMAGE_REPO" --format '{{.Tag}}' \
      | { grep -E '^([0-9a-f]{40}|rollback-[0-9a-f]{12})$' || true; } \
      | while IFS= read -r tag; do
          docker image inspect -f "{{.Created}} {{.Id}} $tag" "$IMAGE_REPO:$tag"
        done \
      | sort -r
  )
}

main() {
  if ! [[ "${IMAGE_TAG:-}" =~ ^[0-9a-f]{40}$ ]]; then
    fail_note "IMAGE_TAG must be the full 40-character commit SHA."
    exit 1
  fi
  export IMAGE_TAG
  log "Deploying $IMAGE_REPO:$IMAGE_TAG"

  cd "$APP_ROOT"
  if [ ! -f "$SOURCE_TARBALL" ] || [ ! -f "$UPLOADED_ENV" ]; then
    fail_note "Release bundle or environment file missing in $APP_ROOT."
    exit 1
  fi

  record_previous_image
  stage_release

  # Keep public traffic on Traefik/HTTPS only. The API container is
  # reachable to Traefik through Docker's shared_infra network.
  ufw delete allow 3001/tcp || true

  # Remove old legacy collision folder if present
  rm -rf "$APP_ROOT/app"

  cd "$APP_DIR"
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

  log "Deploying ReconCentral container via docker compose with project name $COMPOSE_PROJECT..."
  local release_ok=1
  if ! compose up -d --no-build --remove-orphans; then
    log "docker compose up failed for $IMAGE_REPO:$IMAGE_TAG."
    release_ok=0
  fi

  # Symlink to /docker/reconcentral for native Hostinger Docker Manager hPanel
  # detection. Cosmetic, so it must never abort the script before the
  # health check / rollback below.
  if ! { mkdir -p "$(dirname "$HPANEL_LINK")" && ln -sfn "$APP_DIR" "$HPANEL_LINK"; }; then
    log "Warning: could not update $HPANEL_LINK; continuing."
  fi

  if [ "$release_ok" -eq 1 ] && ! verify_release "$APP_DIR/.env"; then
    release_ok=0
  fi

  if [ "$release_ok" -eq 1 ] && [ "$ROLLBACK_DRILL" = "true" ]; then
    printf '::notice::%s\n' "Rollback drill: $IMAGE_REPO:$IMAGE_TAG passed its checks; rolling back to $IMAGE_REPO:$PREV_TAG on purpose."
    if rollback; then
      printf '::notice::%s\n' "Rollback drill passed: production is running $IMAGE_REPO:$PREV_TAG and is healthy."
      exit 0
    fi
    fail_note "Rollback drill failed."
    exit 1
  fi

  if [ "$release_ok" -ne 1 ]; then
    log "Last 200 log lines of the failed release:"
    docker logs "$APP_CONTAINER" --tail=200 || true
    if rollback; then
      fail_note "Release $IMAGE_TAG failed verification. Rolled back to $IMAGE_REPO:$PREV_TAG, which is healthy."
    fi
    exit 1
  fi

  docker tag "$IMAGE_REPO:$IMAGE_TAG" "$IMAGE_REPO:latest"
  rm -rf "$PREV_DIR"
  prune_release_images
  log "Deployed $IMAGE_REPO:$IMAGE_TAG."
}

# Called on the last line so bash has read the whole script from stdin before
# any command runs (nothing below can swallow the rest of the script).
main "$@"
