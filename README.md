# ReconCentral

Multi-marketplace seller finance & reconciliation dashboard (Flipkart-first, Amazon growing).

## Stack

- **Frontend:** React 18 + Vite + Tailwind (`frontend/`)
- **Backend:** Express + PostgreSQL (`backend/`)
- **Auth:** Firebase Auth + Postgres roles (`viewer` · `analyst` · `operator` · `admin`)

## Quick start (local)

1. Ensure the Hostinger PostgreSQL database is reachable through `DATABASE_URL` or `PG_*`.
2. Copy `backend/.env.example` → `backend/.env` (or use existing `.env`) with `DATABASE_URL` / `PG_*`.
3. From repo root:

```bat
START.bat
```

Or run each service separately:

```bash
cd backend && npm run dev
cd frontend && npm run dev
```

- App: http://localhost:5173  
- API: http://localhost:3001  

### Share with teammates (same Wi‑Fi / office LAN)

1. You run `START.bat` on your PC (backend + frontend).
2. The batch file prints a **Team URL** like `http://192.168.1.40:5173`.
3. Teammates open that link in their browser — they do **not** need the repo or START.bat.
4. First time only: run `START.bat` **as Administrator** so Windows Firewall allows ports **5173** and **3001**.
5. If login fails from their browser, add your LAN IP under Firebase Console → Authentication → Settings → **Authorized domains**.

Detect IP anytime:

```bat
powershell -File scripts\lan-ip.ps1
```

## Roles

| Role | Access |
|------|--------|
| viewer | Read dashboards |
| analyst | Read + **export** reports |
| operator | Upload / Data Hub / return tracking |
| admin | Users, rate cards, clear data, charges |

## Data Center uploads

The Uploads page deliberately shows only the file types supported by the
selected marketplace. Do not add a generic/overlapping button: each selection
must use the importer for its own source layout.

| Selection | Buttons shown, in upload order |
|---|---|
| **Flipkart** | Sales / Orders → Returns → FK Settlement Report |
| **Amazon** | Sale Orders → FBA Returns → Flex Returns → Settlement (Payment) |
| **Myntra (EJ)** | Sales / Orders → Returns → Invoice / Payment |
| **Myntra (VB)** | Sales / Orders → Returns → Invoice / Payment |

For Myntra, select the correct account before upload. Every Order and Return
row validates its seller ID before any data is saved: EJ is `45833`; VB is
`10708`. The third Myntra step is its account-scoped Invoice / Payment importer,
not a Flipkart settlement file.

After every successful upload, the operator can save an optional batch remark.
The UI reports it as saved only after PostgreSQL confirms that the matching
`upload_log` row was updated. The remark then remains visible in both upload
history views after refresh.

Clearing a dataset requires an administrator-provided reason. It removes the
imported business rows but retains the filename, counts, remark, clearing user,
time, reason, and deleted-row counts in **All upload history** under **Cleared
data**.

See [docs/DATA_CENTER_UPLOADS.md](docs/DATA_CENTER_UPLOADS.md) for the UI,
endpoint, and regression-test contract. Myntra parser and data-model details
remain in [docs/MYNTRA_HANDOFF.md](docs/MYNTRA_HANDOFF.md).

## Money glossary

- **Gross Revenue** — invoice / sale amount  
- **Bank Received** — net settlement credited (legacy UI may still say “My Share”)  
- **Fees Paid** — marketplace fee deductions  
- **Unsettled** — orders with no settlement row  

## Production

See [docs/DEPLOY.md](docs/DEPLOY.md) for the Hostinger VPS Docker production
setup. The final database target is PostgreSQL running in Docker on the VPS and
reached by the API through `DATABASE_URL`.

## Architecture and development

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the route/service/data
structure, permission boundaries, and rules used to prevent duplicate report
implementations.

For the production data-quality, freshness, security, and maintenance baseline,
see [docs/SAAS_OPERATING_BASELINE.md](docs/SAAS_OPERATING_BASELINE.md).

## Task & Work Tracking (TaskFlow Pro)

All development tasks, audits, bug fixes, and feature progress are tracked in real-time on **TaskFlow Pro**:
- **TaskFlow App**: [https://task.youthnic.shop/](https://task.youthnic.shop/)
- **Integration Guide**: [docs/TASKFLOW_INTEGRATION.md](docs/TASKFLOW_INTEGRATION.md)
- **Agent Rules**: Configured in [GEMINI.md](GEMINI.md) and [AGENTS.md](AGENTS.md) to automatically synchronize all coding sessions.


## Security

- Never commit `.env` or service-account JSON (see `.gitignore`).
- Prefer `VITE_FIREBASE_*` and `ADMIN_SEED_*` env vars over hardcoded seeds.
