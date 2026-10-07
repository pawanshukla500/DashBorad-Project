# Hostinger VPS deployment

This deployment runs ReconCentral as one Node.js Docker container behind
Traefik. The container serves the React build, `/api`, and `/health`; Traefik
handles HTTPS routing. PostgreSQL runs in Docker on the same Hostinger VPS and
should be reachable from the API through a private Docker or local host-gateway
path.

## First-time VPS setup

1. Point the production domain's `A` record to the VPS IPv4 address.
2. In Hostinger, open ports **80** and **443** only. Do not open 3001, 5173, or
   PostgreSQL to the public internet for production traffic.
3. Install Docker Engine and the Docker Compose plugin on the VPS.
4. Clone this repository once:

   ```bash
   sudo mkdir -p /opt/reconcentral
   sudo chown "$USER":"$USER" /opt/reconcentral
   git clone YOUR_GITHUB_REPOSITORY_URL /opt/reconcentral
   cd /opt/reconcentral
   ```

5. Create `/opt/reconcentral/.env` with permissions `600`. It stays on the
   VPS and is never copied by GitHub Actions:

   ```dotenv
   APP_DOMAIN=app.example.com
   ACME_EMAIL=ops@example.com
   NODE_ENV=production
   CORS_ORIGINS=https://app.example.com

   DATABASE_URL=postgresql://USER:PASSWORD@postgres:5432/paymentapp
   DATABASE_ENGINE=postgresql
   PG_SSL=false
   PG_POOL_MAX=20
   PG_POOL_MIN=2
   PG_POOL_IDLE_TIMEOUT_MS=55000
   PG_POOL_MAX_LIFETIME_SECONDS=900
   # Dashboard reads fail fast enough to release pool connections under load.
   # Import/rebuild transactions clear this session limit explicitly.
   PG_READ_STATEMENT_TIMEOUT_MS=45000
   PG_HEALTHCHECK_INTERVAL_MS=25000

   # Add the existing Firebase Admin and optional notification variables here.
   # GOOGLE_APPLICATION_CREDENTIALS must reference a file mounted into the API
   # container, or use your supported inline credential configuration.
   ```

6. Start it:

   ```bash
   docker compose --env-file .env -f docker-compose.production.yml up -d --build
   docker compose -f docker-compose.production.yml ps
   curl -fsS https://app.example.com/health
   ```

`PG_SSL=false` is intended only for the private same-VPS Docker path (`postgres:5432`).

### Hardened PostgreSQL Configuration on Hostinger VPS

The database container `postgresql-6k6a-postgresql-1` is hardened as follows:
- **Zero Public WAN Exposure**: Port 5432 is NOT published to `0.0.0.0` or public IPs. It is bound strictly to `127.0.0.1:5433:5432` on the VPS loopback interface.
- **Private Docker Network**: The container is attached to the external bridge network `shared_infra` with the network alias `postgres`.
- **Private Production App Connectivity**: Any Docker container attached to `shared_infra` (such as `reconcentral` or `pvms`) reaches PostgreSQL privately via `postgres:5432` without going over the public internet:
  ```dotenv
  DATABASE_URL=postgresql://pawanshukla:PASSWORD@postgres:5432/paymentapp
  PG_SSL=false
  ```
- **Health Check**: The PostgreSQL compose project should include a native
  `pg_isready` healthcheck so Hostinger/Docker Manager reports database health
  directly, not only the API container's health.

The PostgreSQL service should use this network and health shape:

```yaml
services:
  postgresql:
    ports:
      - "127.0.0.1:5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d paymentapp"]
      interval: 30s
      timeout: 5s
      retries: 5
    networks:
      shared_infra:
        aliases:
          - postgres

networks:
  shared_infra:
    external: true
```
- **Automated Daily Backups**:
  - Script: `/opt/backups/scripts/backup-postgres.sh`
  - Daily cron: `/etc/cron.d/postgres-backup` (runs at 02:00 UTC)
  - Performs full cluster dump (`pg_dumpall`) and individual database dumps (`paymentapp`, `packing_database`, etc.).
  - Gzip compressed into `/opt/backups/postgres/` with 14-day automatic rotation.

### Local Windows Development (Encrypted SSH Tunnel)

For local development on Windows, connect through the encrypted SSH tunnel:
```bash
# Start tunnel directly
npm run tunnel

# Or use START.bat which automatically checks and launches the tunnel
START.bat
```
The tunnel maps local `127.0.0.1:5432` -> VPS `127.0.0.1:5433` securely over SSH. Local `backend/.env` uses:
```dotenv
DATABASE_URL=postgresql://pawanshukla:PASSWORD@localhost:5432/paymentapp
PG_SSL=false
```

`/health` returns HTTP 200 only when the API can reach PostgreSQL. If the
database is temporarily unavailable, the API stays running, returns a clear
503, and retries its database connection automatically.

## GitHub Actions deployment

Add these repository secrets:

| Secret | Value |
|---|---|
| `HOSTINGER_HOST` | VPS IP address or hostname |
| `HOSTINGER_USER` | Non-root deployment user |
| `HOSTINGER_SSH_KEY` | Private key for that user |
| `HOSTINGER_SSH_PORT` | Usually `22` |

Pushes to `master` run tests and the frontend build before the deploy job.
The deploy job uploads the checked-out source and a generated `.env` to
`/opt/reconcentral`, then pipes
[`scripts/deploy/hostinger-deploy.sh`](../scripts/deploy/hostinger-deploy.sh)
to the VPS over SSH. The script verifies that the API container can resolve
the configured database host from inside Docker and that `/health` reports a
connected, schema-ready PostgreSQL runtime before CI/CD passes.

### Releases, rollback and pre-deploy backups

Each deploy runs these steps in order:

1. Records the rollback target. This is the image the `ReconCentral`
   container is running if Docker reports it healthy. If the container is
   missing or unhealthy, the target is `reconcentral:latest` instead, the
   last release that passed its checks. A target that is not already under a
   commit-SHA tag is pinned as `reconcentral:rollback-<image id>`.
2. Moves the current `/opt/reconcentral/ReconCentral` to
   `ReconCentral.prev` and unpacks the new release in its place.
3. Builds `reconcentral:<commit SHA>`. The old container keeps serving during
   the build. If the build fails, the job stops and production is unchanged.
4. Takes `pg_dump -Fc` of **`paymentapp` only** into
   `/opt/backups/reconcentral-predeploy/paymentapp_<UTC time>_<sha12>.dump`
   (directory `700`, files `600`). The dump runs through `docker exec` on
   the shared Postgres container's local socket, so no password is used and
   the container is never restarted. The whole archive is read back with
   `pg_restore -f /dev/null` to catch truncation. The last 5 dumps are
   kept.
   - Before dumping, the script checks free disk space against the database
     size plus 2 GB of headroom. If space is short, or the dump fails, the
     deploy **aborts before the new container starts** and production is
     unchanged.
   - For an urgent fix while the disk is full, run the workflow manually
     with **skip_predeploy_backup** checked. Then the nightly dump is the
     only restore point.
5. Runs `docker compose ... up -d --no-build`. The new container applies its
   startup migrations.
6. Runs the private-DB-route, `/health` and public HTTPS checks. If any check
   fails, the script:
   - saves the failed container's last 500 log lines to
     `/opt/reconcentral/deploy-logs/<time>_<sha12>.app.log` (root-only,
     last 10 kept). They are not printed, because Actions logs on a public
     repository are public;
   - restores `ReconCentral.prev` (the compose file and `.env` the previous
     container was created from). If that `.env` differs from the newly
     uploaded one, for example after a secret rotation, the job adds a
     warning without printing either file;
   - points `latest` back at the previous image;
   - runs `up -d --no-build --force-recreate` with
     `IMAGE_TAG=<previous tag>`, re-checks health, and **fails the job**.
     The `::error::` annotation states which tag production is on.
7. On success, the script points `reconcentral:latest` at the new release
   ("last known good") and records it in `/opt/reconcentral/good-releases`.
   It then keeps the images of the last 3 releases that passed their checks,
   plus the running image and the rollback target. Failed builds are removed
   at the next successful deploy; their logs stay in `deploy-logs/`. Only
   commit-SHA and `rollback-*` tags are managed; other images on the host
   are not touched. There is no `docker image prune` anymore.

Each run's full output is also written to
`/opt/reconcentral/deploy-logs/<time>_<sha12>.deploy.log` (last 20 kept).
Every probe has a time limit. The script ignores SIGHUP and keeps logging to
that file if its SSH session disappears, for example when the job is
cancelled or times out. So a deploy that has already started still finishes
its checks and, if needed, its rollback. In that case, read the outcome from
the log file. A lock (`/opt/reconcentral/.deploy.lock`) makes the next
deploy wait for it.

`latest` always means the last release that passed its checks, so a plain
`docker compose up -d` from Hostinger Docker Manager (no `IMAGE_TAG`) starts a
known-good image.

**Schema changes are not rolled back.** Startup migrations are additive and
idempotent, and the previous image normally runs fine on the newer schema.
If a release damaged data, restore `paymentapp` from its pre-deploy dump (see
below). Do not restart the Postgres container: it hosts other databases.

#### Manual rollback to an older release

```bash
docker image ls reconcentral          # available tags, newest first
cd /opt/reconcentral/ReconCentral
IMAGE_TAG=<sha-or-rollback-tag> docker compose -p reconcentral \
  -f docker-compose.production.yml --env-file .env up -d --no-build --force-recreate
docker tag reconcentral:<sha-or-rollback-tag> reconcentral:latest
```

#### Restoring paymentapp from a pre-deploy dump

Restore into a scratch database first and check it. This affects only the new
database, never `paymentapp` or the other databases in the cluster. `<db user>`
is the user in `DATABASE_URL`.

```bash
PG=postgresql-6k6a-postgresql-1
DUMP=/opt/backups/reconcentral-predeploy/paymentapp_<stamp>_<sha12>.dump
docker exec "$PG" createdb -U <db user> paymentapp_restore_check
docker exec -i "$PG" pg_restore -U <db user> -d paymentapp_restore_check --no-owner < "$DUMP"
```

Restoring over the live `paymentapp` discards every write made after the
dump. Only do it as a deliberate decision: stop `ReconCentral` first, run
`pg_restore --clean --if-exists --single-transaction -d paymentapp`, then
start the container again. Dumps written through a pipe do not support
`pg_restore -j`; restore them serially.

#### Testing the rollback path safely

- **No server needed:** `bash scripts/deploy/test-hostinger-deploy.sh` runs the
  real script against a fake `docker`. It covers:
  - a healthy deploy, and an unhealthy one (`/health` or the public HTTPS
    check fails) that rolls back;
  - the first deploy on a legacy `latest`-only server, both success and
    failure;
  - rollback to `latest` when there is no running container;
  - low disk, a failed `pg_dump`, a failed build and an unreadable bundle;
  - retention when some releases failed;
  - the drill, including the roll-forward case;
  - an SSH session that disappears mid-deploy.

  CI runs it, plus `shellcheck`, on every PR.
- **Real drill on the VPS:** in a quiet window, run the workflow manually on
  `master` with **rollback_drill** checked. It deploys the current commit,
  checks it, then deliberately rolls back to the image that was running.
  Expect two container recreations, each with the same brief downtime as a
  normal deploy.
  The job is green only if the rolled-back container passes the health
  checks, and the log ends with `Rollback drill passed`.
  - Afterwards, `docker inspect -f '{{.Config.Image}}' ReconCentral` shows
    `reconcentral:rollback-…` or the previous SHA.
  - The drill code equals the running code, so nothing needs undoing. The
    next normal deploy moves forward again.
  - If the rollback target turns out to be unhealthy, the drill rolls
    forward to the release it just verified, so production is not left
    down. The job then fails with `Rollback drill failed ... rolled forward`.

#### Host image-prune cron

`/etc/cron.d/docker-image-prune` runs `docker image prune -af --filter
"until=24h"` daily. It deletes every image no container uses, including
release images kept for rollback. Release images carry the label
`com.reconcentral.release=true`. Adding `--filter
"label!=com.reconcentral.release"` to that cron line keeps them. Until then,
manual rollback is reliable only to images built in the last 24 hours. The
automatic in-deploy rollback is affected only if the cron happens to fire in
the few minutes between `up` and the rollback. If it does, the job's
`::error::` says the rollback image no longer exists.

The ReconCentral compose file exposes port `3001` only to Docker networks.
Traefik remains the public entrypoint on ports `80` and `443`; direct public
access to `3001` should not be required.

### Database resilience and report load

- Keep production PostgreSQL on the private Docker network (`postgres:5432`)
  or use TLS with certificate verification for a public database host. Do not
  use a public direct connection with `PG_SSL_REJECT_UNAUTHORIZED=false`.
- `PG_READ_STATEMENT_TIMEOUT_MS` defaults to `45000` for interactive reads.
  Long imports and settlement rebuilds use an explicit transaction connection
  and clear the session timeout, so lowering this value does not interrupt
  those jobs.
- The API keeps a bounded pool with TCP keepalive, retries safe reads after
  transient socket failures, recreates stale pools in the background, and
  returns `503` instead of empty business data while PostgreSQL is unavailable.
- Read-only report responses (dashboard, sales, P&L, profit analysis,
  settlement statements, filters) share one server cache
  (`backend/services/reportCache.js`). An entry is dropped after every
  successful API write, at the end of background import jobs, and whenever
  PostgreSQL's per-table write counters change (so writes from another
  instance or a script are picked up within about a second).
  `REPORT_CACHE_TTL_MS` (default 10 minutes) is only an upper bound. The
  Refresh button's `_refresh` token recomputes each report once per click.
- If the API reports `DATABASE_STARTING` or `DB_UNAVAILABLE`, check the API
  logs and database health first rather than repeatedly restarting the
  container:

  ```bash
  docker compose -f docker-compose.production.yml ps
  docker compose -f docker-compose.production.yml logs --tail=200 api
  docker compose -f docker-compose.production.yml exec api getent hosts postgres
  curl -i http://127.0.0.1/health
  ```

### PostgreSQL server tuning (Postgres container)

The PostgreSQL container runs with stock settings. Measured on production
(September 2026, 1.8 GB database): `shared_buffers=128MB`, `work_mem=4MB`,
`jit=on`; the buffer cache hit ratio was 92.8% and report queries had spilled
97 GB of temporary files to disk. The API already turns JIT off for its own
sessions. Apply the following to the PostgreSQL service in its own compose file
(these are server settings; they are not part of this repository), sized to the
VPS RAM, then restart that container:

```yaml
services:
  postgresql:
    shm_size: 1g            # parallel queries use /dev/shm (Docker default is 64 MB)
    command:
      - postgres
      - -c
      - shared_buffers=1GB  # ~25% of RAM (8 GB VPS); 512MB on 4 GB
      - -c
      - effective_cache_size=4GB  # ~50-75% of RAM
      - -c
      - work_mem=16MB       # per sort/hash node, per connection; keep modest
      - -c
      - maintenance_work_mem=256MB
      - -c
      - random_page_cost=1.1      # SSD/NVMe storage
      - -c
      - effective_io_concurrency=200
      - -c
      - jit=off
```

After the restart, `SHOW shared_buffers;` should report the new value.
`pg_stat_statements` (`shared_preload_libraries=pg_stat_statements`, then
`CREATE EXTENSION pg_stat_statements;` in `paymentapp`) is recommended so slow
queries can be identified from real traffic.

## Recovery commands

```bash
cd /opt/reconcentral/ReconCentral
docker compose -p reconcentral -f docker-compose.production.yml logs -f reconcentral
docker compose -p reconcentral -f docker-compose.production.yml ps
docker inspect -f '{{.Config.Image}}' ReconCentral   # which release is running
curl -i http://127.0.0.1/health
# Restart the last known-good release without rebuilding:
docker compose -p reconcentral -f docker-compose.production.yml --env-file .env up -d --no-build
```

For a database outage, do not restart the API repeatedly. Restore database
reachability and TLS/private-network settings first. The running API health
monitor reconnects every 20 seconds, and browser read requests retry short
interruptions automatically.
