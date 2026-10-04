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

## ✅ Findings / security-adjacent concerns already addressed (PR #44, PR #45)

These items surfaced in the reviews of PR #44 (Phase 0.5 ledger) and
PR #45 (colour/contrast pass) and are now closed:

| Concern | Resolution | PR |
|---|---|---|
| Plaintext TaskFlow PAT in `docs/NOTION_PROJECT_BRIEF.md` (PAT was on line 160 at PR #42 time; placeholder now on line 198) | Replaced live PAT with `<TASKFLOW_PAT — load from local MCP config>` placeholder | PR #42, commit `57202b0` |
| SOR workspace reachable by viewers | Workspace hidden in Sidebar (`roles: EXPORT_ROLES`); each `/sor/*` route redirects viewers to `/` | PR #42, commit `2245e31` |
| White-on-light-burgundy token mismatches (LoginPage hero, App.jsx avatar, AdminCenterPage avatars, SorPageShell badges) | Light surfaces now use `text-on-primary-container` (burgundy); dark surfaces use `text-on-primary` (white) | PR #45, commit `972c046` |
| Global `:focus-visible` outline was old indigo `#3525cd` | Now `#902A4A` (brand burgundy) in `frontend/src/index.css` | PR #45, commit `972c046` |
| Hardcoded indigo hex `#3525cd`, `bg-indigo-600`, `bg-indigo-50/*`, `text-indigo-700` in `OutstandingPaymentsPage` + `CalculatorPage` | Replaced with brand tokens (`bg-primary`, `bg-primary-container/*`, `text-primary`) | PR #45, commit `972c046` |
| `IX_sor_invoice_line_type_invoice` index crashed existing installs (ran before `line_type` was added by `ensureSorLedgerSchema`) | Moved the index inside `ensureSorLedgerSchema` so it runs after the column is added | PR #44, commit `98ba9e7` |
| `sor_outstanding` view-creation `.catch(e => console.warn(...))` swallowed errors but still recorded the schema version | Removed the swallow — failed view now logs + prevents version insert so repair retries on next boot | PR #44, commit `98ba9e7` |
| `/api/sor/:portal/invoices` had no pagination — invoice-picker requests transferred every invoice for a portal | Added `?page=1&pageSize=200` with hard cap 500 + `LIMIT/OFFSET` | PR #44, commit `98ba9e7` |

## 🟡 Pre-existing concerns still open

| Concern | Resolution | Where |
|---|---|---|
| Plaintext TaskFlow PAT in `docs/TASKFLOW_INTEGRATION.md:79` (committed 2026-09-10 in `db37fd7`, pre-dates the 2026-10 audit) | **Still open** — flagged for separate PR + token rotation in TaskFlow project settings | Not yet addressed |
| `bg-indigo-50/*`, `bg-indigo-100` tonal highlights on SalesPage / ReturnsPage / StatementPage / RateAuditPage / PaymentReconciliationPage | **Pure tonal highlights** — no contrast issue, just wrong hue. Will sweep in a follow-up PR after the readability fixes settle. | Out of scope for PR #45 |

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