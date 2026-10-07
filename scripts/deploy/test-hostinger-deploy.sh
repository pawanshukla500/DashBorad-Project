#!/usr/bin/env bash
# Pipes scripts/deploy/hostinger-deploy.sh into `bash -s` (as the workflow
# does over SSH) with a fake `docker` (plus fake df/curl/sleep/ufw) on PATH, so
# the rollback, backup and retention paths can be tested without a VPS, a
# Docker daemon or a database.
#
#   bash scripts/deploy/test-hostinger-deploy.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$HERE/hostinger-deploy.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
pass() { printf '  ok   %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
check() { # check "description" command...
  local what="$1"; shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}
absent() { ! grep -qE -- "$1" "${2:-/dev/stdin}"; } # absent regex [file]

sha() { printf 'abcdef%034d' "$1"; } # a fake 40-hex commit SHA

# ---------------------------------------------------------------- fakes ----
make_fakes() {
  mkdir -p "$WORK/bin"
  cat > "$WORK/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# Minimal stateful stand-in for the docker CLI calls the deploy script makes.
# State: tags/<tag> -> image id, images/<id> -> created, container -> "id ref",
# bad/<id> -> /health fails, badpublic/<id> -> public HTTPS check fails.
set -uo pipefail
S="$FAKE_STATE"
printf '%s\n' "$*" >> "$S/calls.log"

resolve() { # ref -> image id (no sha256: prefix) or fail
  local ref="$1"
  case "$ref" in
    sha256:*) [ -f "$S/images/${ref#sha256:}" ] && printf '%s' "${ref#sha256:}" ;;
    reconcentral:*) [ -f "$S/tags/${ref#reconcentral:}" ] && cat "$S/tags/${ref#reconcentral:}" ;;
    *) return 1 ;;
  esac
}
render() { # template id
  local out="$1" id="$2" p_id='{{.Id}}' p_created='{{.Created}}'
  out="${out//"$p_id"/sha256:$id}"
  out="${out//"$p_created"/$(cat "$S/images/$id")}"
  printf '%s\n' "$out"
}
new_image() {
  local n id
  n=$(( $(cat "$S/counter") + 1 )); echo "$n" > "$S/counter"
  id="$(printf '%012d%052d' "$n" 0)"
  printf '2026-10-07T10:%02d:%02dZ' $((n / 60)) $((n % 60)) > "$S/images/$id"
  printf '%s' "$id"
}
running_id() { [ -f "$S/container" ] && cut -d' ' -f1 "$S/container"; }

cmd="$1"; shift
case "$cmd" in
  inspect)
    fmt="$2"; target="$3"
    if [ "$target" = "ReconCentral" ]; then
      [ -f "$S/container" ] || { echo "No such object: $target" >&2; exit 1; }
      read -r cid cref < "$S/container"
      case "$fmt" in
        '{{.Image}}') echo "sha256:$cid" ;;
        '{{.Config.Image}}') echo "$cref" ;;
        *State.Health*) if [ -f "$S/bad/$cid" ]; then echo unhealthy; else echo healthy; fi ;;
        *) exit 1 ;;
      esac
    else # the postgres container
      if [ "$fmt" = '{{.State.Running}}' ]; then echo "${FAKE_PG_RUNNING:-true}"; fi
    fi
    ;;
  image)
    sub="$1"; shift
    case "$sub" in
      inspect)
        if [ "$1" = "-f" ]; then fmt="$2"; ref="$3"; else fmt=""; ref="$1"; fi
        id="$(resolve "$ref")" || { echo "No such image: $ref" >&2; exit 1; }
        if [ -n "$fmt" ]; then render "$fmt" "$id"; fi
        ;;
      ls) for f in "$S/tags"/*; do if [ -e "$f" ]; then basename "$f"; fi; done ;;
      rm)
        tag="${1#reconcentral:}"
        [ -f "$S/tags/$tag" ] || exit 1
        id="$(cat "$S/tags/$tag")"
        # Like docker: the last tag of an image a container uses cannot go.
        if [ "$(running_id)" = "$id" ] && [ "$(grep -lxF "$id" "$S/tags"/* | wc -l)" -le 1 ]; then
          echo "conflict: image is being used by running container" >&2
          exit 1
        fi
        rm -f "$S/tags/$tag"
        ;;
    esac
    ;;
  tag)
    id="$(resolve "$1")" || exit 1
    printf '%s' "$id" > "$S/tags/${2#reconcentral:}"
    ;;
  compose)
    sub=""
    for a in "$@"; do case "$a" in build|up) sub="$a"; break ;; esac; done
    image_line="$(sed -n 's/^ *image: *//p' docker-compose.production.yml | head -n 1)"
    pattern='${IMAGE_TAG:-latest}'
    ref="${image_line//"$pattern"/${IMAGE_TAG:-latest}}"
    case "$sub" in
      build)
        if [ "${FAKE_BUILD_FAIL:-}" = 1 ]; then echo "fake build failure" >&2; exit 1; fi
        id="$(new_image)"
        printf '%s' "$id" > "$S/tags/${ref#reconcentral:}"
        if [ "${ref#reconcentral:}" = "${FAKE_BAD_TAG:-none}" ]; then touch "$S/bad/$id"; fi
        if [ "${ref#reconcentral:}" = "${FAKE_BAD_PUBLIC_TAG:-none}" ]; then touch "$S/badpublic/$id"; fi
        ;;
      up)
        case " $* " in *" --no-build "*) ;; *) echo "up without --no-build" >&2; exit 1 ;; esac
        id="$(resolve "$ref")" || { echo "image $ref missing and --no-build given" >&2; exit 1; }
        echo "$id $ref" > "$S/container"
        echo "$PWD" > "$S/container_dir"
        ;;
    esac
    ;;
  exec)
    stdin=0
    if [ "$1" = "-i" ]; then stdin=1; shift; fi
    target="$1"; shift
    if [ "$target" = "ReconCentral" ]; then
      cid="$(running_id)" || exit 1
      case "$*" in
        */health*) if [ -f "$S/bad/$cid" ]; then exit 1; fi ;;
      esac
      exit 0
    fi
    case "$1" in
      psql) echo "${FAKE_DB_BYTES:-1900000000}" ;;
      pg_dump)
        printf 'PGDMP-fake-archive\n'
        if [ "${FAKE_DUMP_FAIL:-}" = 1 ]; then exit 1; fi
        # A truncated archive: pg_dump "succeeds" but the data stops early.
        if [ "${FAKE_DUMP_TRUNCATE:-}" != 1 ]; then printf 'END-OF-ARCHIVE\n'; fi
        ;;
      pg_restore)
        # Like `pg_restore -f /dev/null`: reads the whole stream and fails
        # unless it is a complete archive.
        [ "$stdin" = 1 ] || exit 1
        data="$(cat)"
        [ "${data:0:5}" = "PGDMP" ] && [ "${data: -14}" = "END-OF-ARCHIVE" ]
        ;;
    esac
    ;;
  logs) echo "FAKE-APP-LOG customer@example.test" ;;
  ps) exit 0 ;;
  *) echo "fake docker: unsupported: $cmd $*" >&2; exit 1 ;;
esac
FAKE

  cat > "$WORK/bin/df" <<'FAKE'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/sda1 100000000 40000000 %s 40%% /\n' "${FAKE_AVAIL_KB:-60000000}"
FAKE
  cat > "$WORK/bin/curl" <<'FAKE'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$FAKE_STATE/calls.log"
cid="$(cut -d' ' -f1 "$FAKE_STATE/container")" || exit 7
if [ -f "$FAKE_STATE/badpublic/$cid" ]; then exit 22; fi
exit 0
FAKE
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/sleep"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/ufw"
  chmod +x "$WORK/bin/"*
}

# --------------------------------------------------------------- fixture ----
make_release_tarball() { # marker compose_image
  local src="$WORK/src"
  rm -rf "$src"; mkdir -p "$src"
  printf 'services:\n  reconcentral:\n    image: %s\n' "$2" > "$src/docker-compose.production.yml"
  echo "$1" > "$src/RELEASE"
  tar -czf "$ROOT/reconcentral-source.tar.gz" -C "$src" .
  if [ "${CORRUPT_TARBALL:-}" = 1 ]; then echo "not a tarball" > "$ROOT/reconcentral-source.tar.gz"; fi
  printf 'APP_DOMAIN=example.test\nDATABASE_URL=postgresql://appuser:s3cret@postgres:5432/paymentapp\n%s' \
    "${ENV_EXTRA:-}" > "$ROOT/hostinger.env"
}

new_scenario() {
  export FAKE_STATE="$WORK/state-$1"
  ROOT="$WORK/root-$1"
  mkdir -p "$FAKE_STATE/tags" "$FAKE_STATE/images" "$FAKE_STATE/bad" "$FAKE_STATE/badpublic" "$ROOT"
  echo 0 > "$FAKE_STATE/counter"
  : > "$FAKE_STATE/calls.log"
}

seed_image() { # n tag... -> prints id
  local id t
  id="$(printf '%012d%052d' "$1" 0)"
  printf '2026-10-01T00:00:%02dZ' "$(($1 % 60))" > "$FAKE_STATE/images/$id"
  shift
  for t in "$@"; do printf '%s' "$id" > "$FAKE_STATE/tags/$t"; done
  printf '%s' "$id"
}

seed_release_dir() { # marker compose_image
  mkdir -p "$ROOT/ReconCentral"
  printf 'services:\n  reconcentral:\n    image: %s\n' "$2" > "$ROOT/ReconCentral/docker-compose.production.yml"
  echo "$1" > "$ROOT/ReconCentral/RELEASE"
  printf 'DATABASE_URL=postgresql://appuser:s3cret@postgres:5432/paymentapp\n' > "$ROOT/ReconCentral/.env"
}

# A server as it looks before this change: one image tagged `latest`, running,
# deployed from a compose file that hard-codes reconcentral:latest.
seed_legacy_server() {
  LEGACY_ID="$(seed_image 999 latest)"
  echo "$LEGACY_ID reconcentral:latest" > "$FAKE_STATE/container"
  seed_release_dir legacy 'reconcentral:latest'
}

deploy() { # tag [extra env assignments...]; sets RC and OUT
  local tag="$1"; shift
  make_release_tarball "release-$tag" 'reconcentral:${IMAGE_TAG:-latest}'
  set +e
  OUT="$(env PATH="$WORK/bin:$PATH" APP_ROOT="$ROOT" HPANEL_LINK="$ROOT/hpanel/reconcentral" \
    BACKUP_DIR="$ROOT/backups" HEALTH_ATTEMPTS=2 IMAGE_TAG="$tag" "$@" bash -s < "$DEPLOY" 2>&1)"
  RC=$?
  set -e
}

running_ref() { cut -d' ' -f2 "$FAKE_STATE/container"; }
running_image() { cut -d' ' -f1 "$FAKE_STATE/container"; }
tag_id() { cat "$FAKE_STATE/tags/$1" 2>/dev/null; }
release_dir_marker() { cat "$ROOT/ReconCentral/RELEASE"; }
line_of() { grep -n -m1 -e "$1" "$FAKE_STATE/calls.log" | cut -d: -f1; }
dump_count() { find "$ROOT/backups" -maxdepth 1 -name 'paymentapp_*.dump' 2>/dev/null | wc -l | tr -d ' '; }
release_tags() { find "$FAKE_STATE/tags" -type f ! -name latest | wc -l | tr -d ' '; }
build_dump_up_in_order() {
  [ "$(line_of 'compose.* build')" -lt "$(line_of 'pg_dump')" ] \
    && [ "$(line_of 'pg_dump')" -lt "$(line_of 'compose.* up ')" ]
}
has_tags() { local t; for t in "$@"; do [ -n "$(tag_id "$t")" ] || return 1; done; }
lacks_tags() { local t; for t in "$@"; do [ -z "$(tag_id "$t")" ] || return 1; done; }
in_output() { grep -qF -- "$1" <<<"$OUT"; }
not_in_output() { ! grep -qF -- "$1" <<<"$OUT"; }
show_output_on_failure() { [ "$FAILURES" -eq "$1" ] || printf '%s\n' "$OUT" | sed 's/^/      | /'; }

make_fakes
A="$(sha 1)"; B="$(sha 2)"; C="$(sha 3)"; D="$(sha 4)"; E="$(sha 5)"; F="$(sha 6)"
G="$(sha 7)"; H="$(sha 8)"; I="$(sha 9)"; J="$(sha 10)"; K="$(sha 11)"

echo "1. first deploy on a legacy server (single latest tag)"
new_scenario main; seed_legacy_server; before=$FAILURES
deploy "$A"
check "exit 0" [ "$RC" -eq 0 ]
check "container runs reconcentral:$A" [ "$(running_ref)" = "reconcentral:$A" ]
check "latest points at the new image" [ "$(tag_id latest)" = "$(tag_id "$A")" ]
check "legacy image pinned as rollback-*" [ "$(tag_id "rollback-${LEGACY_ID:0:12}")" = "$LEGACY_ID" ]
check "build, then pg_dump, then up" build_dump_up_in_order
check "one backup written" [ "$(dump_count)" = 1 ]
if [ "$(uname -s)" = Linux ]; then # NTFS under Git Bash has no Unix modes
  check "backup is private (mode 600)" [ "$(stat -c %a "$ROOT"/backups/paymentapp_*.dump)" = 600 ]
fi
check "only paymentapp dumped" grep -q -- 'pg_dump -w -U appuser -d paymentapp -Fc' "$FAKE_STATE/calls.log"
check "whole archive read back" grep -q -- 'pg_restore -f /dev/null' "$FAKE_STATE/calls.log"
check "previous release dir removed" [ ! -e "$ROOT/ReconCentral.prev" ]
check "run log kept on the server" grep -qF "Deploying reconcentral:$A" "$ROOT"/deploy-logs/*.deploy.log
check "no secret in output" not_in_output s3cret
show_output_on_failure "$before"

echo "2. unhealthy release rolls back to the previous commit tag"
before=$FAILURES
ENV_EXTRA=$'JWT_SECRET=n3w-v4lue\n' deploy "$B" FAKE_BAD_TAG="$B"
check "exit non-zero" [ "$RC" -ne 0 ]
check "container back on reconcentral:$A" [ "$(running_ref)" = "reconcentral:$A" ]
check "rollback used up --no-build --force-recreate" grep -q -- 'compose.* up -d --no-build --force-recreate' "$FAKE_STATE/calls.log"
check "latest still the last good image" [ "$(tag_id latest)" = "$(tag_id "$A")" ]
check "previous release directory restored" [ "$(release_dir_marker)" = "release-$A" ]
check "rollback ran from the restored directory" [ "$(cat "$FAKE_STATE/container_dir")" = "$ROOT/ReconCentral" ]
check "failed image kept for debugging" has_tags "$B"
check "error annotation explains the rollback" in_output "::error::Release $B failed verification. Rolled back to reconcentral:$A"
check "app logs kept off the CI log" not_in_output FAKE-APP-LOG
check "app logs saved on the server" grep -q FAKE-APP-LOG "$ROOT"/deploy-logs/*.app.log
check "warns that rollback restored a different .env" in_output '::warning::The rolled-back release uses its previous .env'
check "warning does not print the secret" not_in_output n3w-v4lue
show_output_on_failure "$before"

echo "3. low disk aborts before the new container starts"
before=$FAILURES; : > "$FAKE_STATE/calls.log"; dumps_before="$(dump_count)"
deploy "$C" FAKE_AVAIL_KB=1000
check "exit non-zero" [ "$RC" -ne 0 ]
check "compose up never ran" absent 'compose.* up ' "$FAKE_STATE/calls.log"
check "pg_dump never ran" absent pg_dump "$FAKE_STATE/calls.log"
check "container untouched" [ "$(running_ref)" = "reconcentral:$A" ]
check "previous release directory restored" [ "$(release_dir_marker)" = "release-$A" ]
check "no backup added" [ "$(dump_count)" = "$dumps_before" ]
check "low-disk annotation" in_output '::error::Low disk space'
show_output_on_failure "$before"

echo "4. failed pg_dump aborts before the new container starts"
before=$FAILURES; : > "$FAKE_STATE/calls.log"
deploy "$C" FAKE_DUMP_FAIL=1
check "exit non-zero" [ "$RC" -ne 0 ]
check "compose up never ran" absent 'compose.* up ' "$FAKE_STATE/calls.log"
check "no partial dump left behind" [ -z "$(find "$ROOT/backups" -name '*.partial')" ]
check "container untouched" [ "$(running_ref)" = "reconcentral:$A" ]
check "previous release directory restored" [ "$(release_dir_marker)" = "release-$A" ]
show_output_on_failure "$before"

echo "4b. truncated dump (pg_dump exit 0) is rejected before the new container starts"
before=$FAILURES; : > "$FAKE_STATE/calls.log"; dumps_before="$(dump_count)"
deploy "$C" FAKE_DUMP_TRUNCATE=1
check "exit non-zero" [ "$RC" -ne 0 ]
check "compose up never ran" absent 'compose.* up ' "$FAKE_STATE/calls.log"
check "truncated dump not kept" [ "$(dump_count)" = "$dumps_before" ]
check "no partial dump left behind" [ -z "$(find "$ROOT/backups" -name '*.partial')" ]
check "container untouched" [ "$(running_ref)" = "reconcentral:$A" ]
check "annotation names the incomplete archive" in_output 'is not a complete archive'
show_output_on_failure "$before"

echo "5. failed build changes nothing"
before=$FAILURES; : > "$FAKE_STATE/calls.log"
deploy "$C" FAKE_BUILD_FAIL=1
check "exit non-zero" [ "$RC" -ne 0 ]
check "no backup, no up" absent 'pg_dump|compose.* up ' "$FAKE_STATE/calls.log"
check "previous release directory restored" [ "$(release_dir_marker)" = "release-$A" ]
show_output_on_failure "$before"

echo "6. unreadable release bundle changes nothing"
before=$FAILURES; : > "$FAKE_STATE/calls.log"
CORRUPT_TARBALL=1 deploy "$C"
check "exit non-zero" [ "$RC" -ne 0 ]
check "no build, no up" absent 'compose' "$FAKE_STATE/calls.log"
check "previous release directory restored" [ "$(release_dir_marker)" = "release-$A" ]
check "container untouched" [ "$(running_ref)" = "reconcentral:$A" ]
show_output_on_failure "$before"

echo "7. retention keeps the last 3 good releases, not failed builds"
before=$FAILURES
for t in "$C" "$D" "$E"; do deploy "$t" BACKUP_KEEP=2; [ "$RC" -eq 0 ] || fail "deploy $t"; done
for t in "$G" "$H"; do deploy "$t" BACKUP_KEEP=2 FAKE_BAD_TAG="$t"; [ "$RC" -ne 0 ] || fail "deploy $t should fail"; done
deploy "$I" BACKUP_KEEP=2
check "exit 0" [ "$RC" -eq 0 ]
check "container runs reconcentral:$I" [ "$(running_ref)" = "reconcentral:$I" ]
check "last three good releases kept (I, E, D)" has_tags "$I" "$E" "$D"
check "failed builds and older releases removed" lacks_tags "$G" "$H" "$C" "$A" "$B"
check "exactly 3 release images" [ "$(release_tags)" = 3 ]
check "never tried to remove an in-use image" not_in_output 'Could not remove'
check "two dumps kept" [ "$(dump_count)" = 2 ]
show_output_on_failure "$before"

echo "8. skip_predeploy_backup deploys without pg_dump"
before=$FAILURES; : > "$FAKE_STATE/calls.log"
deploy "$F" SKIP_PREDEPLOY_BACKUP=true
check "exit 0" [ "$RC" -eq 0 ]
check "no pg_dump" absent pg_dump "$FAKE_STATE/calls.log"
check "warning annotation" in_output '::warning::Pre-deploy backup of paymentapp skipped'
show_output_on_failure "$before"

echo "9. rollback drill on the commit that is already running"
before=$FAILURES; prev_id="$(tag_id "$F")"
deploy "$F" ROLLBACK_DRILL=true
check "exit 0 when the rollback is healthy" [ "$RC" -eq 0 ]
check "rolled back to a pinned rollback-* tag of the old image" [ "$(running_ref)" = "reconcentral:rollback-${prev_id:0:12}" ]
check "latest points at the rolled-back image" [ "$(tag_id latest)" = "$prev_id" ]
check "drill notice" in_output '::notice::Rollback drill passed'
check "no leftover release directories" [ ! -e "$ROOT/ReconCentral.next" ]
show_output_on_failure "$before"

echo "10. public HTTPS check failure also rolls back"
before=$FAILURES; prev_image="$(running_image)"
deploy "$J" FAKE_BAD_PUBLIC_TAG="$J"
check "exit non-zero" [ "$RC" -ne 0 ]
check "public route was probed" grep -q '^curl .*https://example.test/health' "$FAKE_STATE/calls.log"
check "back on the previous image" [ "$(running_image)" = "$prev_image" ]
show_output_on_failure "$before"

echo "11. drill whose rollback target is unhealthy rolls forward"
before=$FAILURES
touch "$FAKE_STATE/bad/$(running_image)"
deploy "$K" ROLLBACK_DRILL=true
check "exit non-zero" [ "$RC" -ne 0 ]
check "production back on the new release" [ "$(running_ref)" = "reconcentral:$K" ]
check "latest points at the new release" [ "$(tag_id latest)" = "$(tag_id "$K")" ]
check "release directory is the new release" [ "$(release_dir_marker)" = "release-$K" ]
check "roll-forward annotation" in_output 'Production rolled forward to reconcentral:'"$K"
show_output_on_failure "$before"

echo "12. invalid IMAGE_TAG is refused"
before=$FAILURES
deploy "latest"
check "exit non-zero" [ "$RC" -ne 0 ]
show_output_on_failure "$before"

echo "12b. SSH session gone mid-deploy: the rollback still completes"
before=$FAILURES; prev_image="$(running_image)"; L="$(sha 12)"; : > "$FAKE_STATE/calls.log"
make_release_tarball "release-$L" 'reconcentral:${IMAGE_TAG:-latest}'
set +e
# `head` stops reading after two lines, like a dropped SSH channel.
env PATH="$WORK/bin:$PATH" APP_ROOT="$ROOT" HPANEL_LINK="$ROOT/hpanel/reconcentral" \
  BACKUP_DIR="$ROOT/backups" HEALTH_ATTEMPTS=2 IMAGE_TAG="$L" FAKE_BAD_TAG="$L" \
  bash -s < "$DEPLOY" 2>&1 | head -n 2 > /dev/null
set -e
OUT="$(cat "$(ls -t "$ROOT"/deploy-logs/*.deploy.log | head -n 1)")"
check "the new release was started" grep -q -- 'compose.* up -d --no-build --remove-orphans' "$FAKE_STATE/calls.log"
check "and then rolled back" grep -q -- 'compose.* up -d --no-build --force-recreate' "$FAKE_STATE/calls.log"
check "back on the previous image" [ "$(running_image)" = "$prev_image" ]
check "server-side log records the rollback" in_output "::error::Release $L failed verification. Rolled back to"
show_output_on_failure "$before"

echo "13. failed first deploy on a legacy server rolls back to the legacy image"
new_scenario legacyfail; seed_legacy_server; before=$FAILURES
deploy "$A" FAKE_BAD_TAG="$A"
check "exit non-zero" [ "$RC" -ne 0 ]
check "legacy image running again" [ "$(running_image)" = "$LEGACY_ID" ]
check "legacy compose file restored" [ "$(release_dir_marker)" = legacy ]
check "latest still the legacy image" [ "$(tag_id latest)" = "$LEGACY_ID" ]
show_output_on_failure "$before"

echo "14. no running container: rollback target is latest"
new_scenario nocontainer; before=$FAILURES
good_id="$(seed_image 500 "$A" latest)"
seed_release_dir "release-$A" 'reconcentral:${IMAGE_TAG:-latest}'
deploy "$B" FAKE_BAD_TAG="$B"
check "exit non-zero" [ "$RC" -ne 0 ]
check "latest's image is running" [ "$(running_image)" = "$good_id" ]
check "explains the choice" in_output 'The running container is absent; using reconcentral:latest'
show_output_on_failure "$before"

echo "15. drill on a first-ever deploy (nothing to roll back to)"
new_scenario fresh; before=$FAILURES
deploy "$A" ROLLBACK_DRILL=true
check "exit non-zero" [ "$RC" -ne 0 ]
check "new release keeps serving" [ "$(running_ref)" = "reconcentral:$A" ]
check "latest points at the new release" [ "$(tag_id latest)" = "$(tag_id "$A")" ]
check "recorded as a good release" grep -qx "$A" "$ROOT/good-releases"
check "explains that nothing was rolled back" in_output 'Rollback drill could not start a rollback'
show_output_on_failure "$before"

if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "All deploy script checks passed."
