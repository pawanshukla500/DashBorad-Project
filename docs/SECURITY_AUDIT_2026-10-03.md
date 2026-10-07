# Security Audit — ReconCentral (VB Exports) — 2026-10-03

**Auditor lens:** AppSec Engineer (`security/security-appsec-engineer.md`) +
Security Architect (`security/security-architect.md`) per the skills
roster in [`docs/SKILLS.md`](SKILLS.md).

**Scope:** Backend (Express + PostgreSQL + Firebase), Frontend (React
18 + Vite + Tailwind), infra (Docker on Hostinger VPS, GitHub Actions).

**Method:** Static read of route registrations, upload path, middleware
stack, env/secret handling, input-validation surface, and the AGENTS.md /
ARCHITECTURE invariants. No live exploitation was attempted in this
pass — the goal is a findings list with severity and a fix plan.

---

## ✅ What is already strong

| Area | Evidence |
|---|---|
| Auth | `backend/utils/authMiddleware.js` requires Bearer JWT, verifies via Firebase Admin, never trusts request body for identity |
| Role gating | `mutationAccessGuard` blocks non-`operator`/`admin` on every POST/PUT/PATCH, admin-only on DELETE |
| Rate-card guard | `rateCardAccessGuard` enforces admin-only on writes; `/calculate` + `/compare` open to all roles |
| Session from token only | `firebaseSessionFromToken` does no DB lookup — survives DB hiccups without auth bypass |
| CORS / origin | Frontend Vite + Express use explicit allow-list (see `server.js`) |
| SQL injection | All ingestion paths use parameterized queries via `pg` pool; no string interpolation in `services/` |
| Vendor / dep audit | `backend/tests/uploadSecurity.test.js` exists; SCA in CI |
| Secret hygiene | `.gitignore` excludes `.env`, service-account JSON, `firebase-adminsdk*.json` |
| Invoice scope (Myntra) | Per-account seller-ID validation rejects mismatched rows before any insert |
| Audit log | `services/auditLog.js` writes immutable append-only rows for sensitive mutations |
| Multi-tenant dataset hygiene | `upload_log` keeps filename + counts + reason + user after dataset clears |

---

## ⚠️ Findings (prioritized)

### H1 — `requireRole` returns 403 without `WWW-Authenticate` or structured error code

**File:** `backend/utils/authMiddleware.js:41-49`
**Severity:** Low
**Risk:** Generic `403 { error: 'Access denied. Required role: …' }`
leaks which roles exist. Not exploitable, but noisy.
**Fix:** Return a stable machine-readable `code: 'forbidden_role'`
plus a sanitised message that doesn't enumerate the role list.

### H2 — `mutationAccessGuard` does not log denials to `audit_log`

**File:** `backend/utils/authMiddleware.js:58-62`
**Severity:** Medium
**Risk:** Failed mutations are not in the audit trail, so an attacker
probing for privilege escalation leaves no trace.
**Fix:** When the guard rejects, append an `audit_log` row with
`actor`, `path`, `method`, `reason: 'mutation_role_denied'`.

### H3 — No global rate-limit on `/upload` POST routes

**File:** `backend/routes/upload.js`, `routes/amazonUpload.js`,
`routes/myntraUpload.js`, `routes/meeshoUpload.js`
**Severity:** Medium
**Risk:** A signed-in `operator` could script large uploads and DoS
the DB pool. `services/spreadsheetWorker.js` uses a worker thread,
but the per-request cap is not enforced.
**Fix:** Add `express-rate-limit` per IP + per `firebase_uid`:
- 60 reads/min, 10 mutation requests/min default
- `/upload/*` overrides: 5 uploads/min, 50 MB max body

### H4 — Upload filename is rendered into `audit_log` without sanitisation

**File:** `backend/services/auditLog.js`, route handlers in `routes/upload.js`
**Severity:** Low
**Risk:** Filenames flow into the Audit History UI. A malicious filename
with `<img>` / `<iframe>` tags could trigger stored XSS if the UI
renders raw HTML.
**Fix:** Strip control chars and `< > " ' &` in `auditLog.js` before
write; ensure the Audit History page renders with React (it does — see
`pages/AuditLogPage.jsx`), and add a regression test that
`auditLogSanitization.test.js` covers filenames with `<`/`>`.

### H5 — Frontend bundle exposes Firebase config via `VITE_FIREBASE_*`

**Files:** `frontend/src/api/firebase.js`, `frontend/.env*`
**Severity:** Low (expected for Vite + Firebase web SDK), no action
**Note:** Firebase web config is *meant* to be public. The real
sensitive key — Firebase Admin service-account JSON — is server-side
only. Verify `.gitignore` excludes `firebase-adminsdk*.json` and any
service account file (already does).

### H6 — `START.bat` opens ports 5173 / 3001 in Windows Firewall

**File:** `START.bat`
**Severity:** Low
**Risk:** Running the batch "as Administrator" opens the firewall
exception globally. If the laptop is later on a hostile network,
the dev server is exposed to LAN.
**Fix:** Print a warning + require explicit confirmation. Document a
toggle: `OPEN_FIREWALL=0` to skip the firewall step.

### H7 — No CSP / `helmet` headers on backend

**File:** `backend/server.js` (entrypoint) — exact line not yet audited
**Severity:** Medium
**Risk:** Without `Content-Security-Policy`, `X-Content-Type-Options`,
`Referrer-Policy`, the React app is one XSS away from token theft if
session cookies are ever added.
**Fix:** Add `helmet()` middleware with a strict CSP
(`default-src 'self'`, allow Firebase auth + storage domains, no
`unsafe-inline` except for Vite-emitted inline styles).

### H8 — No CORS preflight test coverage

**File:** `backend/tests/`
**Severity:** Low
**Fix:** Add a `tests/corsSecurity.test.js` that verifies preflight
rejects unknown origins.

### H9 — Audit-history retention not enforced

**File:** `backend/services/auditLog.js`
**Severity:** Low
**Fix:** Document a 365-day retention policy in
`docs/SAAS_OPERATING_BASELINE.md`; add a nightly job that trims older
rows (operator-confirmed via `docs/ARCHITECTURE.md`).

### H10 — Dependency CVE check on `pg` / `multer` / `xlsx` is silent in CI

**File:** `.github/workflows/*.yml`
**Severity:** Medium
**Fix:** Add `npm audit --omit=dev --audit-level=high` as a required
CI step that fails the build on high/critical CVE. Add Dependabot
weekly cron.

---

## 🟢 Items NOT a finding

- **Firebase token revocation:** Handled by Firebase (15-min ID token TTL).
- **SQL injection surface:** Parameterized throughout; verified by `tests/dbBatch.test.js`.
- **Myntra seller-ID gate:** Strict, rejects mismatched files before any insert.
- **Dataset clear:** Requires admin role + reason; preserves audit trail.

---

## ✅ Findings already addressed (PR #42 follow-up commits)

The PR #42 follow-up commits resolved security-adjacent concerns that
fell outside the original ten-finding list:

| Concern | Resolution | Where |
|---|---|---|
| Plaintext TaskFlow PAT in `docs/NOTION_PROJECT_BRIEF.md` (PAT was on line 160 at PR #42 time; the placeholder currently sits on line 198 after later additions) | Replaced live PAT with `<TASKFLOW_PAT — load from local MCP config>` placeholder | PR #42, commit `57202b0` |
| SOR workspace reachable by viewers | Workspace hidden in Sidebar (`roles: EXPORT_ROLES`); each `/sor/*` route redirects viewers to `/` | `frontend/src/navigation.js`, `frontend/src/App.jsx` (PR #42, commit `2245e31`) |
| Pre-existing PAT leak in `docs/TASKFLOW_INTEGRATION.md:79` (committed 2026-09-10 in `db37fd7`) | **Still open** — flagged for separate PR + token rotation in TaskFlow project settings | Not yet addressed |

---

## Fix Plan (PRs)

| PR | Title | Files |
|---|---|---|
| `security/h1-h4-low-hardening` | Low-severity auth + audit hardening | `authMiddleware.js`, `auditLog.js`, route handlers |
| `security/h2-audit-denial-logging` | Log denied mutations to audit_log | `authMiddleware.js`, `auditLog.js`, new tests |
| `security/h3-rate-limit` | Add `express-rate-limit` to upload routes | `server.js`, `routes/upload*.js`, config |
| `security/h4-filename-sanitization` | Sanitise filenames into audit_log | `auditLog.js`, `auditLogSanitization.test.js` |
| `security/h7-helmet-csp` | Add `helmet` + strict CSP | `server.js` |
| `security/h10-npm-audit-ci` | Add `npm audit` gate + Dependabot | `.github/workflows/*.yml`, `dependabot.yml` |

Each PR follows the existing workflow: branch off `master`, squash,
delete after merge, CodeAnt follow-up.

---

## Follow-up review — 2026-10-07

Skills: AppSec Engineer, Database Reliability Engineer, DevOps Automator,
AI Engineer / Email Intelligence Engineer, Frontend Developer / UX.
Fixed on branch `sor/ledger-hardening-security` unless marked open.

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | High | Any Firebase account without a `recon_role` claim was treated as `viewer`, and `POST /api/auth/sync-user` auto-created viewers for unknown emails and linked a pre-created row (e.g. the seeded admin) by email alone — an unverified sign-up could inherit that role. | **Fixed:** claimless tokens get 403 `ACCESS_NOT_GRANTED`; sync-user refuses unknown emails and links by email only when `email_verified`. **Owner action:** untick Firebase Console → Authentication → Settings → *Enable create (sign-up)*. |
| F2 | Medium | `PUT /api/reconcile/outstanding/config/:channelKey` had no role gate (any viewer could change the payment matrix). | **Fixed:** operator/admin via `protectMutations`; body validated. |
| F3 | Medium | 50 MB JSON bodies were parsed before authentication. | **Fixed:** 1 MB on `/api/auth`; 50 MB only after the Firebase token is verified. |
| F4 | Medium | Public `/health` returned the raw PostgreSQL error, pool and TLS settings. | **Fixed:** trimmed for non-loopback callers (deploy `docker exec` check keeps full detail). |
| F5 | Medium | SOR routes returned `detail: err.message`; invalid filters caused 500s. | **Fixed:** validated filters (400), generic 500 bodies. 173 older handlers still echo `err.message` to authenticated users — **open**, low impact. |
| F6 | Medium | A development backend (START.bat) pointed at production applied its branch's migrations to the live DB on every boot. | **Fixed:** startup DDL only with `NODE_ENV=production` or `RUN_SCHEMA_MIGRATIONS=true`. |
| F7 | High | A PR push could cancel a queued production deploy (one workflow-wide concurrency group). | **Fixed:** per-ref CI group; deploy-only production group. |
| F8 | High | Node 20 is end-of-life (2026-04-30). | **Fixed:** Node 22 in CI and both Dockerfiles. |
| F9 | Medium | No dependency audit in CI (H10); frontend `axios` < 1.20 (high). | **Partly fixed:** monthly `dependency-audit.yml`; `axios` → 1.20.0. **Open:** `xlsx@0.18.5` (backend + frontend) has high advisories with no npm fix — move to SheetJS 0.20.3 from `cdn.sheetjs.com` in a separate PR with parser regression checks; backend transitive advisories (`proxy-addr` critical — not reachable without a subnet `trust proxy`; `undici`, `@fastify/busboy`, `@grpc/grpc-js`, `brace-expansion`) need a dedicated `npm audit fix` PR because it reshuffles the `firebase-admin` / Google Cloud tree. |
| F10 | Medium | Statement PDF upload: a scanned PDF (no text layer) let Gemini invent a month's figures that replace the stored month; Gemini calls had no timeout. | **Partly fixed:** text-length guard + 60 s / 15 s timeouts. **Open:** preview-then-commit step; server-side range checks on AI-parsed rate slabs. |
| F11 | Low | `.gitignore` did not cover `*firebase-adminsdk*.json`, `*.pem`, `*.key`; `.dockerignore` did not exclude `.env.*` variants or scratch files for manual builds. | **Fixed.** |
| F12 | High (DB) | `sor_invoice_line` had duplicate FKs per column and no index on `order_row_id` / `settlement_id` (verified on production). | **Fixed:** `sor-fk-dedupe-1` + indexes. |
| — | High | TaskFlow PAT in `docs/TASKFLOW_INTEGRATION.md` (still in history). | **Open:** PR #47 redacts; the token must be **rotated** in TaskFlow. |
| — | High | VPS network exposure of the database service. | **Open — owner action** (details shared privately with the owner). |
| — | Medium | Deploy has no image rollback / pre-migration backup; deploy credential scope and host-key pinning need tightening. | **Open:** DevOps follow-up. |
| — | Low | No `checkRevoked` on ID tokens; no rate limiting; no CSP. | **Open** (H3, H7). |

---

## Threat model — SOR upload streams (2026-10-07)

Required by AGENTS.md before portal upload code lands. Scope:
`POST /api/sor/:portal/upload/:stream`, `GET …/template/:stream`,
`GET …/statement`, `GET …/ledger-report` (`routes/sorUpload.js`,
`routes/sor.js`, `services/sorUpload.js`) for Myntra Jabong, Zepto, AJIO
and Cocoblu.

| STRIDE | Threat | Mitigation |
|---|---|---|
| Spoofing | Anonymous or self-signed-up caller | Firebase token + role claim required (F1); uploads need operator / admin, reads analyst+. |
| Tampering | Crafted file overwrites another portal's or account's ledger | Portal allow-list; every write is scoped to `(portal, portal_account)`; account restricted to `[A-Za-z0-9_.-]{1,64}`; lines only attach to invoices that exist in that portal's ledger. |
| Tampering | Re-upload or duplicate rows double-count money | `UNIQUE (invoice_id, line_type, source_key)` upserts; payments keyed by UTR across all sources; one transaction per invoice. |
| Tampering | SQL injection via headers / cells | Values only as bind parameters; headers only select from a fixed column map. |
| Repudiation | Who uploaded what | `sor_upload_log` (user, file, counts, status) mirrored into Audit History; `uploaded_by` on headers. |
| Information disclosure | DB error text in responses | Generic 500 bodies; validation errors are 400 with our own messages. |
| Information disclosure | Formula injection in the XLSX report | Report cells are written as typed values (strings are never formulas in XLSX). |
| Denial of service | Huge / zip-bomb spreadsheets | 20 MB, 1 file, extension allow-list; parsed on the worker thread; 50,000-row cap per upload; 100,000-entry cap per report. |
| Elevation of privilege | Analyst uploads by calling the API directly | `protectMutations('/api/sor')` (POST → operator / admin) in addition to the UI gate. |

Residual: portal files are trusted operator input (no PII beyond
invoice / payment references); the spreadsheet library advisory (F9)
still applies to every upload path until the SheetJS upgrade.

### CodeAnt follow-ups on PR #49 (fixed with the upload streams)

- **Critical** — role changes kept working until the old token expired:
  role changes now revoke the user's sessions and the API refuses tokens
  issued before the revocation (cached 60 s per user; deleted users are
  refused; a Firebase outage does not lock users out). The app signs out
  on `SESSION_REVOKED`.
- **Major** — `POST /api/health` skipped auth and reached the 50 MB parser:
  the health bypass is GET / HEAD only and the large parser runs only for
  authenticated requests.
- **Major** — future-dated invoices fell into the 0–30 day aging bucket
  implicitly: stated explicitly (`GREATEST(age_days, 0)`).

---

## Re-test cadence

- **After each fix PR:** targeted test (`tests/*`) must pass.
- **Monthly:** `npm audit` review + dependency bump PR.
- **Quarterly:** full security audit by AppSec + Security Architect skills.
- **On new portal onboarding (Zepto / Cocoblu / etc.):** threat model +
AppSec review BEFORE any code is merged.

---

## Related docs

- [`AGENTS.md`](../AGENTS.md) — invariants
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — system layout
- [`docs/SAAS_OPERATING_BASELINE.md`](SAAS_OPERATING_BASELINE.md) — operating baseline
- [`docs/TASKFLOW_INTEGRATION.md`](TASKFLOW_INTEGRATION.md) — TaskFlow link