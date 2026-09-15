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
The VPS pulls only fast-forward Git history, then recreates changed containers.
The deployment stops if tests fail or the VPS has unexpected local Git edits.
The deploy job also verifies that the API container can resolve the configured
database host from inside Docker and that `/health` reports a connected,
schema-ready PostgreSQL runtime before CI/CD passes.

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
- Dashboard and Profit & Loss report responses are cached briefly and
  invalidated after successful mutations. A browser refresh bypasses the cache
  with `_refresh`.
- If the API reports `DATABASE_STARTING` or `DB_UNAVAILABLE`, check the API
  logs and database health first rather than repeatedly restarting the
  container:

  ```bash
  docker compose -f docker-compose.production.yml ps
  docker compose -f docker-compose.production.yml logs --tail=200 api
  docker compose -f docker-compose.production.yml exec api getent hosts postgres
  curl -i http://127.0.0.1/health
  ```

## Recovery commands

```bash
cd /opt/reconcentral
docker compose -f docker-compose.production.yml logs -f api
docker compose -f docker-compose.production.yml ps
curl -i http://127.0.0.1/health
docker compose --env-file .env -f docker-compose.production.yml up -d --build
```

For a database outage, do not restart the API repeatedly. Restore database
reachability and TLS/private-network settings first. The running API health
monitor reconnects every 20 seconds, and browser read requests retry short
interruptions automatically.
