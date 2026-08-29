# Production deployment guide

ReconCentral long-term hosting: **managed Postgres + always-on API + static frontend**.

## Target architecture

```
[Browser] → [Static host: Cloudflare Pages / Firebase Hosting]
                ↓ HTTPS
           [API: Cloud Run / VPS]
                ↓ private / SSL
           [Managed Postgres: Neon / Cloud SQL / AlloyDB]
```

Do **not** expose Postgres port 5432 to the public internet.

## 1. Managed Postgres

1. Create a Postgres 15+ instance (Neon free tier works for early production).
2. Set `DATABASE_URL` with SSL (`?sslmode=require`) and retain the provider's
   trusted CA. The API rejects an unencrypted non-local database whenever
   `NODE_ENV=production`.
3. Run the app once so `initDb` creates tables + `unified_settlements` view.
4. Enable automated backups / point-in-time recovery.

## 2. API (Cloud Run)

Use existing [`backend/Dockerfile`](../backend/Dockerfile).

Connect directly to the managed database through `DATABASE_URL`.

Env (Secret Manager):

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection |
| `PORT` | `8080` |
| `NODE_ENV` | `production` |
| `CORS_ORIGINS` | Comma-separated static frontend origin(s), e.g. `https://app.example.com` |
| `PG_SSL` | `true` when the connection string does not already carry `sslmode=require` |
| `PG_SSL_REJECT_UNAUTHORIZED` | `true` (the default); do not disable certificate verification for production |
| `PG_SSL_CA` | Provider CA PEM when the host is not signed by a system-trusted CA |
| Firebase Admin credentials | Auth verification |
| `ADMIN_SEED_*` | Optional first admin only |

```bash
gcloud run deploy reconcentral-api \
  --source backend \
  --region asia-south1 \
  --allow-unauthenticated=false \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest
```

## 3. Frontend (static)

```bash
cd frontend
# Set production API URL
echo "VITE_API_BASE_URL=https://YOUR-API.run.app" > .env.production
npm run build
# Deploy frontend/dist to Cloudflare Pages or Firebase Hosting
```

Ensure Axios / `api` client uses `import.meta.env.VITE_API_BASE_URL`.

## 4. Auth & CORS

- Keep Firebase Auth.
- Set `CORS_ORIGINS` to your exact frontend origin(s). In production the API
  rejects browser origins that are not on this allow-list.
- HTTPS only.

## 5. Observability

- Cloud Run request logs + `/health`
- Alert on upload job failures and 5xx spikes
- Weekly DB backup restore drill

## Cutover checklist

- [ ] Managed DB migrated (orders/returns/settlements counts match)
- [ ] `npm run db:verify` reports `sslEnabled: true` and `sslRejectUnauthorized: true`
- [ ] `unified_settlements` present after boot
- [ ] Firebase login works against production API
- [ ] Flipkart + Amazon upload smoke test
- [ ] DNS / custom domain for app + API
- [ ] Revoke any secrets that were ever committed or pasted in chat
