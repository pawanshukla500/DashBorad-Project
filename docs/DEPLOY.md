# Production deployment guide

ReconCentral's final production target is **Hostinger VPS + Docker + PostgreSQL
in Docker**.

## Target architecture

```text
[Browser]
    |
    | HTTPS
    v
[Traefik]
    |
    | Docker network: shared_infra
    v
[ReconCentral Node container serving React + API]
    |
    | Docker/private network: shared_infra
    v
[PostgreSQL Docker container on the Hostinger VPS]
```

The browser must never connect to PostgreSQL directly. PostgreSQL should be
reachable only from the API container through a private Docker network, local
host-gateway binding, VPN, or another private channel.

## Production environment

Create `/opt/reconcentral/.env` on the VPS and keep it out of Git. The app uses
`DATABASE_URL` as the canonical database setting.

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
PG_HEALTHCHECK_INTERVAL_MS=25000
PG_APPLICATION_NAME=reconcentral-api

# Add Firebase Admin credentials and optional notification variables here.
```

Use `PG_SSL=false` only when the API reaches PostgreSQL on the same VPS through
a private Docker/local network. If the database host is a public IP or public
DNS name, configure PostgreSQL TLS and set `PG_SSL=true` instead.

If your existing PostgreSQL container is already attached to the app Docker
network, use its container or network alias, for example `postgres:5432`. If it
is bound only on the VPS host, use `host.docker.internal:PORT`; the production
compose file maps that name to Docker's host gateway for the API container.

## Start or update production

```bash
cd /opt/reconcentral
docker compose --env-file .env -f docker-compose.production.yml up -d --build --remove-orphans
docker compose -f docker-compose.production.yml ps
docker exec ReconCentral node -e "fetch('http://127.0.0.1:3001/health').then(async r=>{const body=await r.json(); if(!r.ok || !body.dbConnected) process.exit(1); console.log(JSON.stringify({dbConnected: body.dbConnected, database: body.database}, null, 2));})"
curl -fsS https://app.example.com/health
```

`/health` returns HTTP 200 only after the API can connect to PostgreSQL and
finish schema checks. During a database outage the API stays up, reports a clear
503, and retries automatically.

## Database checks

From `backend/`, run:

```bash
npm run db:verify
```

The command confirms the active PostgreSQL runtime, database identity, TLS
policy, upload counts, reconciliation migrations, and duplicate-fingerprint
counts.

For the Hostinger Docker setup, the recommended result is:

- `activeDatabase: "postgresql"`
- expected database name, currently `paymentapp`
- `sslEnabled: false` only when the API uses a private Docker/local path
- non-zero upload/history counts matching production data

The `/health` response also exposes `database.pool.idleTimeoutMillis`,
`database.pool.maxLifetimeSeconds`, and `database.poolRecreatePending`. A
healthy same-VPS deployment should normally show the pool connected, schema
ready, and no pending pool recreation.

## Security checklist

- Keep `.env`, Firebase service-account JSON, and database passwords out of Git.
- Do not expose ports `3001`, `5173`, or PostgreSQL to the public internet.
- Open only `80` and `443` for the web container unless a separate private
  administration channel is required.
- Use a low-privilege PostgreSQL user for the API.
- Back up the PostgreSQL Docker volume and test restore before major imports.
- Rotate any secret that was ever committed, pasted into chat, or shared in a
  screenshot.
