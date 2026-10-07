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

sha() { printf 'abcdef%034d' "$1"; } # a fake 40-hex commit SHA

# ---------------------------------------------------------------- fakes ----
make_fakes() {
  mkdir -p "$WORK/bin"
  cat > "$WORK/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# Minimal stateful stand-in for the docker CLI calls the deploy script makes.
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
        [ -n "$fmt" ] && render "$fmt" "$id"
        exit 0
        ;;
      ls) for f in "$S/tags"/*; do [ -e "$f" ] && basename "$f"; done; exit 0 ;;
      rm)
        tag="${1#reconcentral:}"
        [ -f "$S/tags/$tag" ] || exit 1
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
        [ "${FAKE_BUILD_FAIL:-}" = 1 ] && { echo "fake build failure" >&2; exit 1; }
        id="$(new_image)"
        printf '%s' "$id" > "$S/tags/${ref#reconcentral:}"
        if [ "${ref#reconcentral:}" = "${FAKE_BAD_TAG:-none}" ]; then touch "$S/bad/$id"; fi
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
    [ "$1" = "-i" ] && { stdin=1; shift; }
    target="$1"; shift
    if [ "$target" = "ReconCentral" ]; then
      read -r cid _ < "$S/container"
      case "$*" in
        */health*) [ -f "$S/bad/$cid" ] && exit 1 ;;
      esac
      exit 0
    fi
    case "$1" in
      psql) echo "${FAKE_DB_BYTES:-1900000000}" ;;
      pg_dump)
        printf 'PGDMP-fake-archive\n'
        [ "${FAKE_DUMP_FAIL:-}" = 1 ] && exit 1
        exit 0
        ;;
      pg_restore)
        [ "$stdin" = 1 ] || exit 1
        [ "$(head -c 5)" = "PGDMP" ]
        ;;
    esac
    ;;
  ps|logs) exit 0 ;;
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
exit 0
FAKE
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/sleep"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/ufw"
  chmod +x "$WORK/bin/"*
}

# --------------------------------------------------------------- fixture ----
# compose_image: the image: line of the release's compose file.
make_release_tarball() { # marker compose_image
  local src="$WORK/src"
  rm -rf "$src"; mkdir -p "$src"
  printf 'services:\n  reconcentral:\n    image: %s\n' "$2" > "$src/docker-compose.production.yml"
  echo "$1" > "$src/RELEASE"
  tar -czf "$ROOT/reconcentral-source.tar.gz" -C "$src" .
  printf 'APP_DOMAIN=example.test\nDATABASE_URL=postgresql://appuser:s3cret@postgres:5432/paymentapp\n' > "$ROOT/hostinger.env"
}

new_scenario() {
  export FAKE_STATE="$WORK/state-$1"
  ROOT="$WORK/root-$1"
  mkdir -p "$FAKE_STATE/tags" "$FAKE_STATE/images" "$FAKE_STATE/bad" "$ROOT"
  echo 0 > "$FAKE_STATE/counter"
  : > "$FAKE_STATE/calls.log"
  unset FAKE_BAD_TAG FAKE_BUILD_FAIL FAKE_DUMP_FAIL FAKE_AVAIL_KB
}

# A server as it looks before this change: one image tagged `latest`, running,
# deployed from a compose file that hard-codes reconcentral:latest.
seed_legacy_server() {
  local id
  id="$(printf '%012d%052d' 999 0)"
  printf '2026-10-01T00:00:00Z' > "$FAKE_STATE/images/$id"
  printf '%s' "$id" > "$FAKE_STATE/tags/latest"
  echo "$id reconcentral:latest" > "$FAKE_STATE/container"
  mkdir -p "$ROOT/ReconCentral"
  printf 'services:\n  reconcentral:\n    image: reconcentral:latest\n' > "$ROOT/ReconCentral/docker-compose.production.yml"
  echo legacy > "$ROOT/ReconCentral/RELEASE"
  printf 'DATABASE_URL=postgresql://appuser:s3cret@postgres:5432/paymentapp\n' > "$ROOT/ReconCentral/.env"
  LEGACY_ID="$id"
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

running_ref() { read -r _ ref < "$FAKE_STATE/container"; printf '%s' "$ref"; }
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
show_output_on_failure() { [ "$FAILURES" -eq "$1" ] || printf '%s\n' "$OUT" | sed 's/^/      | /'; }

make_fakes
A="$(sha 1)"; B="$(sha 2)"; C="$(sha 3)"; D="$(sha 4)"; E="$(sha 5)"

echo "1. first deploy on a legacy server (single latest tag)"
new_scenario first; seed_legacy_server; before=$FAILURES
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
check "previous release dir removed" [ ! -e "$ROOT/ReconCentral.prev" ]
check "no secret in output" bash -c '! grep -q s3cret <<<"$1"' _ "$OUT"
show_output_on_failure "$before"

echo "2. unhealthy release rolls back to the previous commit tag"
before=$FAILURES
deploy "$B" FAKE_BAD_TAG="$B"
check "exit non-zero" [ "$RC" -ne 0 ]
check "container back on reconcentral:$A" [ "$(running_ref)" = "reconcentral:$A" ]
check "rollback used up --no-build --force-recreate" grep -q -- 'compose.* up -d --no-build --force-recreate' "$FAKE_STATE/calls.log"
check "latest still the last good image" [ "$(tag_id latest)" = "$(tag_id "$A")" ]
check "previous release directory restored" [ "$(release_dir_marker)" = "release-$A" ]
check "rollback ran from the restored directory" [ "$(cat "$FAKE_STATE/container_dir")" = "$ROOT/ReconCentral" ]
check "failed image kept for debugging" [ -n "$(tag_id "$B")" ]
check "error annotation explains the rollback" grep -q "::error::Release $B failed verification. Rolled back to reconcentral:$A" <<<"$OUT"
show_output_on_failure "$before"

echo "3. low disk aborts before the new container starts"
before=$FAILURES; : > "$FAKE_STATE/calls.log"; dumps_before="$(dump_count)"
deploy "$C" FAKE_AVAIL_KB=1000
check "exit non-zero" [ "$RC" -ne 0 ]
check "compose up never ran" bash -c '! grep -q "compose.* up " "$1"' _ "$FAKE_STATE/calls.log"
check "pg_dump never ran" bash -c '! grep -q pg_dump "$1"' _ "$FAKE_STATE/calls.log"
check "container untouched" [ "$(running_ref)" = "reconcentral:$A" ]
check "previous release directory restored" [ "$(release_dir_marker)" = "release-$A" ]
check "no backup added" [ "$(dump_count)" = "$dumps_before" ]
check "low-disk annotation" grep -q '::error::Low disk space' <<<"$OUT"
show_output_on_failure "$before"

echo "4. failed pg_dump aborts before the new container starts"
before=$FAILURES; : > "$FAKE_STATE/calls.log"
deploy "$C" FAKE_DUMP_FAIL=1
check "exit non-zero" [ "$RC" -ne 0 ]
check "compose up never ran" bash -c '! grep -q "compose.* up " "$1"' _ "$FAKE_STATE/calls.log"
check "no partial dump left behind" [ -z "$(find "$ROOT/backups" -name '*.partial')" ]
check "container untouched" [ "$(running_ref)" = "reconcentral:$A" ]
show_output_on_failure "$before"

echo "5. failed build changes nothing"
before=$FAILURES; : > "$FAKE_STATE/calls.log"
deploy "$C" FAKE_BUILD_FAIL=1
check "exit non-zero" [ "$RC" -ne 0 ]
check "no backup, no up" bash -c '! grep -qE "pg_dump|compose.* up " "$1"' _ "$FAKE_STATE/calls.log"
check "previous release directory restored" [ "$(release_dir_marker)" = "release-$A" ]
show_output_on_failure "$before"

echo "6. retention keeps the last 3 release images and BACKUP_KEEP dumps"
before=$FAILURES
for t in "$C" "$D" "$E"; do deploy "$t" BACKUP_KEEP=2; [ "$RC" -eq 0 ] || fail "deploy $t"; done
check "container runs reconcentral:$E" [ "$(running_ref)" = "reconcentral:$E" ]
check "3 release images kept" [ "$(release_tags)" = 3 ]
check "newest three are C, D and E" has_tags "$C" "$D" "$E"
check "two dumps kept" [ "$(dump_count)" = 2 ]
show_output_on_failure "$before"

echo "7. skip_predeploy_backup deploys without pg_dump"
before=$FAILURES; : > "$FAKE_STATE/calls.log"; F="$(sha 6)"
deploy "$F" SKIP_PREDEPLOY_BACKUP=true
check "exit 0" [ "$RC" -eq 0 ]
check "no pg_dump" bash -c '! grep -q pg_dump "$1"' _ "$FAKE_STATE/calls.log"
check "warning annotation" grep -q '::warning::Pre-deploy backup of paymentapp skipped' <<<"$OUT"
show_output_on_failure "$before"

echo "8. rollback drill on the commit that is already running"
before=$FAILURES; prev_id="$(tag_id "$F")"
deploy "$F" ROLLBACK_DRILL=true
check "exit 0 when the rollback is healthy" [ "$RC" -eq 0 ]
check "rolled back to a pinned rollback-* tag of the old image" [ "$(running_ref)" = "reconcentral:rollback-${prev_id:0:12}" ]
check "latest points at the rolled-back image" [ "$(tag_id latest)" = "$prev_id" ]
check "drill notice" grep -q '::notice::Rollback drill passed' <<<"$OUT"
show_output_on_failure "$before"

echo "9. invalid IMAGE_TAG is refused"
before=$FAILURES
deploy "latest"
check "exit non-zero" [ "$RC" -ne 0 ]
show_output_on_failure "$before"

if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "All deploy script checks passed."
