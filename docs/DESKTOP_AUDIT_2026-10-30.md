# Desktop browser and rate-card audit — 30 October 2026

Scope: merged PRs #73–#77, Electron and standalone desktop entry points,
browser adapter, sessions, scraper, staging, publisher, PostgreSQL schemas,
Linux service installer, release preparation and all three Actions workflows.
Baseline commit: `cf7d49a8663b581237e3f1f47d25f5e663af9547`.
Production deployment, production schema changes and production rate-card writes remain gated. On 31 October the user authorized merging PR #78 after CodeAnt and required checks pass.

## Findings before fixes

| Severity | Evidence | Consequence |
| --- | --- | --- |
| Critical | `portalScraper.js` returns constant Shopsy commission, fixed and reverse fees before reading any table | An empty page becomes a seemingly valid rate card |
| High | Scraper and main-process login checks accept body text `seller hub`; the actual signed-out public landing page contains this text | Login is skipped, or the embedded login view closes immediately; subsequent rate-card navigation is unauthenticated |
| High | Actual embedded keyboard test failed with `Typing verification failed ... got length 0`; its offline double passes | Hidden/background keyboard input is unreliable |
| High | Login uses `persist:marketplace-flipkart_shopsy`, extraction uses the selected channel (`flipkart`, `shopsy`, `both`) | Cookies/local storage diverge between login and extraction |
| High | Only literal HTML tables are read; unrecognized or absent Flipkart tables are skipped; any remaining card makes the run successful | Partial runs can reach review, and a layout error is reported too late as `No recognized fee slabs` |
| High | `normalizeScrapedCards` combines FBF/non-FBF only if all arrays match, including order; fixed-fee parser writes seller tiers into the fulfilment column | Distinct fulfilment fees cannot be represented correctly |
| High | Publisher replaces whole category/table sets for any difference, uses conflict targets with raw nullable `end_date`, and does not handle same-day replacement correctly | Unchanged rows are rewritten, duplicates/conflict errors are possible |
| High | Actual configured PostgreSQL read-only inspection found no publisher period/active unique indexes; commission/reverse tables have no fulfilment dimension | Source migrations are not proof of live readiness; publishing must remain gated |
| Medium | Worker first claim is inside a 10-second interval after registration; health probes are serial and requests have no general deadline | Five-second startup target is impossible even on a healthy backend |
| Medium | Dock bounds are measured only on resize/tab click; every bounds/visibility IPC invokes remote token verification | Scroll/layout/auth-banner changes leave a native view misplaced; network delays affect local layout |
| Medium | Manual and scheduled review cards live only in memory; background jobs immediately prune their SQLite evidence | Restart recovery and review evidence are incomplete |
| Medium | `worker.js` builds policy/template cards and supports direct PostgreSQL `--auto-sync`; standalone server also uses a separate direct writer | Entry points do not consistently enforce authenticated API comparison/publication |
| Medium | Release Actions build packages without desktop tests or installed-package smoke tests; Linux systemd launcher is the standalone HTTP server rather than Electron | Build success does not establish runtime success or worker polling on Linux servers |

## Merged PR review

- #73 / `6a2b5e5`: introduces HTTPS worker jobs, SQLite and canonical comparison.
  Reviewed CodeAnt findings and current fixes: role/token isolation and lease/failure
  handling improved, but publication, partial coverage and CLI divergence remain.
- #74 / `ed941cf`: monitor/retry/vault work does not establish authenticated page
  readiness or complete category coverage. Packaged-browser acceptance is absent.
- #75 / `422e822`: accepting `ERR_ABORTED` without proving the final destination
  can mask a failed navigation. Login changes retain weak authentication signals.
- #76 / `8be8b10`: cookie TTL and session purge do not unify Chromium partitions.
  Readiness failures must not be converted into successful empty extractions.
- #77 / `cf7d49a`: public landing-page login flow adds `seller hub`/seller-name
  authentication heuristics. CodeAnt still flags restoration timing. A longer
  fixed sleep does not prove authentication.

## Baseline verification

- Backend: **86 files, 598 tests passed** (48.95 seconds).
- Desktop default suite: **4 SQLite + 71 runtime + 9 mocked E2E passed**.
- Frontend production build: **passed**, 21.30 seconds.
- Installed Windows version: **1.8.3**. ASAR bytes for `main.js`,
  `embeddedBrowser.js`, `portalScraper.js`, `preload.cjs`, `ui/renderer.js`
  match the baseline source. No commit manifest is embedded in that release.
- Authenticated backend account and category reads: **HTTP 200**. The API returns
  Flipkart categories omitted by the scraper's fallback list, including
  `co_ords`, `dress_material`, `kurti`, `shirt`, and additional Shopsy categories.
- PostgreSQL: inspected columns and indexes inside **BEGIN READ ONLY / ROLLBACK**.
- Native Windows screenshot helper failed twice (frame/window capture timeout).
  Electron's own page capture produced a real Seller Hub screenshot locally.
- User completed manual sign-in in the desktop Seller Hub. Saved portal cookies
  restored an authenticated Puppeteer session without password access. Inspected
  visible tables and GraphQL requests for Flipkart/Shopsy and both modes.
- Actual FSN search is essential: generic Kurta returned one 0% commission slab;
  a real database Sangria FSN returned eight product-specific commission slabs.
  Requests carry `variables.input.fsn`, partner context, service profile and date.
  An accepted FSN search and fresh matched responses are required. Reload is
  only a recovery path if the mounted SPA does not issue the requested context.
- Actual responses include 21 reverse-shipping weight/price combinations and
  two FBF pick/pack weight bands with incremental charges. Flattening them loses
  material fee components. The manual SQL migration adds these dimensions.
- Read-only orders catalog has 32 raw brand/category profiles (case aliases are
  deduplicated). Five configured categories have no database FSN: co_ords,
  dress_material, kurti, lehenga_choli, salwar_kurta_dupatta. Full-category staging
  is blocked until real catalog coverage exists; no taxonomy mapping is guessed.
- Local WSL has no usable Linux installation. Linux package execution requires
  a Linux runner; compiling a package on Windows is insufficient acceptance.

## Fix and acceptance boundaries

Fix confirmed session, view lifecycle, pacing, startup, coverage and publication
integrity faults first. Preserve exact evidence, reject incomplete extractions and
unknown layouts. Never fill missing fees with policy defaults. Change extraction
selectors only against authenticated captures. Merge only after required checks,
actual packaged Windows/Linux evidence and CodeAnt review of every commit pass.
Production migration/publication requires separate approval.

## Implemented safeguards and current verification

- Unified persistent portal partition; manual login and 5-minute challenge resume;
  encrypted cookie retention defaults to 30 days and respects portal expiry.
- Dock ResizeObserver/scroll/clipping and local trusted-renderer geometry IPC;
  real editor insertion/readback; load, crash and navigation diagnostics.
- Database FSN discovery, sequential search and fresh matched GraphQL capture;
  strict complete-family/mode validation and no policy-generated fee fallback.
- Durable, account-owned SQLite review recovery and authenticated API diff;
  full changed-row review (including removals and weight increments).
- Row-scoped publisher preserves unchanged records, rejects active duplicates,
  uses current review fingerprints, and refuses missing schema readiness.
  Migration is manual and has not been applied to production.
- Immediate worker registration/claim with bounded requests; actual loopback HTTP
  fixture registers and claims in approximately 50–60ms. Production WAN and
  authenticated installed-worker timing remain separate acceptance checks.
- Backend: 87 files / 612 tests passed; isolated real PostgreSQL integration
  is skipped locally without an explicit loopback fixture database and runs in CI.
- Desktop: 4 SQLite + 68 runtime + 9 E2E + 10 safety tests passed.
- Frontend production build passed in 6.89 seconds.
- Installed-package acceptance is being run. Compilation and unit tests alone
  do not establish Windows/Linux installed runtime success.

At the initial report cutoff, no release tag, deployment, production migration,
merge or production rate publication had been performed. The user later
authorized merging PR #78 after its review gates; production actions remain gated.

## Authenticated live extraction evidence

- Real database FSNs, retrieved read-only by brand/category: 32 raw profiles,
  31 distinct profiles after case-alias deduplication. Complete Chrome run:
  62 observations, 14 categories, 27 Flipkart cards and 4 separate Shopsy cards.
  Both channels pass backend complete-observation validation. Evidence remains
  local in SQLite and private runtime captures; no fees were published.
- Actual Electron WebContentsView run using the production adapter and saved
  cookies: Sangria/Kurta and Shopsy/Kurta, both modes, 4 observations / 2 cards.
  Flipkart commission has 8 slabs; the separate Shopsy response has 1 slab.
- Native authentication required a second observed shell variant: Home,
  Advertising and Help dashboard anchors exist before Orders/Payments dropdowns
  are opened. Marketing body text remains insufficient authentication proof.
- Native input updates React state, but search submission is an explicit Enter
  handler. The search icon is display:none after typing; it is not a valid
  physical click target. URL equality and complete response matching are required.
- Electron 33 Network.getResponseBody fails for actual fee bodies with
  'No resource with given identifier found'. Response-stage Fetch capture works
  for all five fee families and always resumes unrelated and failed requests.
- Initial installed testing found a missing ASAR lockfile in the source manifest,
  unavailable native getVisible API, a geometry test race, and unmet Debian
  dependencies. Manifest now hashes shipped source/assets, checks version and
  commit independently, visibility tracks the requested state on Electron 33,
  dock IPC checks real bounds, and apt resolves declared package dependencies.
- Local packaged Windows Chromium acceptance passes nonblank frame, mouse input,
  hidden OTP editor input, preload/auth barrier, shared HttpOnly cookie session,
  source hash/commit matching and packaged SQLite recovery. Installed NSIS and
  Debian acceptance on GitHub Actions remains the final platform gate.

## Remaining approval and verification boundaries

The full configured-category run is blocked for the five missing database FSNs;
no matching FSNs exist in catalog_cogs either (verified read-only). Shared legacy
commission/collection/reverse tables reject differing fulfilment-mode observations
or conflicting generic fees between brands, rather than flattening them. The
observed account's complete catalog passes these agreement checks. Universal
pick/pack price scope is preserved explicitly through the reviewed migration.

Live production API comparison of these new observations requires the reviewed
backend contract; the currently deployed API is older. The desktop fails closed
when that contract is absent. Actual portal OTP was not triggered by this account;
OTP entry is exercised with real Chromium fixtures. Production WAN registration
latency remains unverified; the real HTTP fixture registers and polls in <100ms.
Production migration/publication and deployment still require separate approval.

Installed Windows NSIS acceptance passed on commit b91d1e6, with all packaged
source hashes and the expected commit verified. Real PostgreSQL fixture migration,
publish, same-day replacement, duplicate rejection and unchanged replay passed on
that commit. Linux Debian installation succeeded; its launcher selection test
matched both a documentation directory and the executable. The workflow now uses
the package-installed command from PATH; Linux runtime acceptance is being rerun.

## Final installed acceptance and dependency audit

On source commit 2b84812, all installed package gates passed:

- Windows: NSIS installation followed by the installed executable's Chromium,
  native mouse/OTP input, source hashes/commit, cookie and SQLite checks.
- Linux: AppImage and Debian builds, apt installation and the installed command
  under Xvfb passed the same runtime checks and expected-commit assertion.
- PostgreSQL: isolated migration, dimensional publication, duplicate rejection,
  same-day replacement and zero-write replay passed (no production connection).
- Backend default suite and frontend build passed. Release publishing was skipped.

Evidence: https://github.com/pawanshukla500/DashBorad-Project/actions/runs/41099285160
and https://github.com/pawanshukla500/DashBorad-Project/actions/runs/41099285196.
The CI artifacts retain the packages, JSON assertion results and native screenshots.

The required dependency audit, npm audit --omit=dev --audit-level=high, currently
fails on existing locked dependencies: backend 14 findings (7 high), desktop 9
findings (5 high), frontend 3 findings (1 high). Backend reports body-parser,
multer, undici and zod/transitive browser tooling among its high findings;
desktop reports extract-zip/browser tooling and zod; frontend reports
follow-redirects. Application test success does not resolve those advisories.
Dependency upgrades need a compatibility and regression pass. CodeAnt review was
pending at this acceptance cutoff; the 31 October follow-up is recorded below.

The stated Shopsy zero-commission invariant is enforced as a validation gate: a
nonzero portal observation is rejected for review. Its value is never replaced
with a constant or silently published.

Commission comparison and the reviewed unique index now use the same trimmed,
case-insensitive brand identity as fee lookup. This covers the observed catalog
case aliases Here&Now/HERE&NOW and rejects duplicate effective brand records.

CodeAnt identified a valid background-job logout race after awaited progress.
Generation is rechecked after that wait and immediately before the HTTPS results
request (including after backend URL discovery), in both desktop entry points.
The real HTTP fixture verifies no results request reaches the server after the
account changes during that await.

## PR #78 follow-up — 31 October 2026

The new CodeAnt review of `d946ef2` found additional correctness gaps: missing
brand/weight inputs to fee calculation, mixed-marketplace previews,
effective-date-independent review fingerprints, optional or missing portal
evidence, unbounded failure screenshots/logs, unrelated NULL `price_max` rows
blocking comparison, ignored saved vertical selections, Shopsy category aliases,
mixed seller accounts, incomplete SQLite staging recovery, transient catalog
lookup outside the retry loop, and unchanged FBF pick-and-pack rows hidden from
review. These findings were checked against the affected query, normalization,
staging and rendering paths.

The fixes select brand and weight on both fee-bearing endpoints; bind review
fingerprints to the effective date; require both FBF/NON_FBF evidence and FBF
pick-and-pack responses; skip malformed rows only when outside the active review
scope; canonicalize plain Shopsy order categories; scope rate snapshots to one
seller account; recover complete SQLite stages and supersede them before a new
scrape; retry API data discovery; render unchanged pick-and-pack fees; and cap
and redact local logs/screenshots. Review and publication are one marketplace at
a time. Release builds produce only the versioned Windows Setup and Linux
AppImage installers. `latest.yml` and the matching blockmap remain as Windows
updater metadata and are labeled as such in release notes.

The Hostinger workflow still runs its test job on master pushes, but deployment
now requires an explicit `workflow_dispatch`. A merge therefore cannot deploy
production. No production rate-card write, production migration or deployment
has been performed.

Validation: backend full suite **617 passed, 2 skipped**; frontend production
build **passed**; desktop suite **4 staging + 70 runtime + 9 E2E + 14
browser-safety checks passed**; focused rate-card/fee tests **22 passed**.
Windows NSIS was built, silently installed and launched locally; all 49 packaged
smoke checks passed, including exact source commit, Chromium frame/input,
preload authorization, shared session cookies and SQLite recovery. The real
Chromium screenshot was nonblank. GitHub must repeat Windows acceptance and run
the Linux AppImage acceptance on the final pushed commit.

## CodeAnt nitpicks follow-up — 31 October 2026

The review also called out six issues on `d946ef2`, each verified against the
current path before correction:

- A worker stopped while `/jobs/claim` was in flight could leave a newly leased
  job idle for five minutes. Both desktop entry points now release a late claim;
  the backend only requeues a still-claimed job held by that exact worker and
  restores the attempt count. A stale or foreign lease is rejected.
- Rate review summaries counted removed slabs as modified. `modified` now counts
  only `MODIFIED`, with a separate `removed` count.
- The installed smoke harness wrote its screenshot before creating the output
  directory. It now creates the destination before any evidence write.
- The PostgreSQL snapshot builder omitted `rc_pick_pack`. It now loads and
  normalizes dimensional pick-and-pack rows under the same effective-date and
  seller-account scope, so unchanged FBF fees appear in review.
- Failure screenshots could contain login or OTP form text. Diagnostic capture
  masks input, textarea, select, and textbox controls during capture and restores
  their prior styles afterward; if masking fails, the screenshot is skipped.
  Screenshots remain local and permission-limited.
- Change-detail rows ignored the active fee filter. Rows now map both backend
  table identifiers and local fee types to the selected filter.

Focused verification passed: 20 backend rate-card/claim-release tests and all 16
desktop browser-safety tests. The full backend suite passed **620 tests with 2
skipped**, the desktop suite passed **4 staging + 70 runtime + 9 E2E + 16
browser-safety tests**, and the frontend production build passed. Installed
Windows acceptance and Linux AppImage acceptance must be repeated on the final
commit containing these follow-up fixes before merge.

## Final CodeAnt follow-up — 31 October 2026

CodeAnt reviewed `dab263b` and returned nine more findings. The fixes now cover
the full set of PostgreSQL rate-card mutation paths and desktop review flow:

- Manual period saves, workbook seeding, legacy sync services and reviewed
  publication all take the same transaction advisory lock before changing rate
  rows. A manual save can no longer interleave between a fingerprint comparison
  and its publish transaction.
- The worker-results API can discard and cancel an owned scrape or sync job,
  clearing stored observations and diff data. Desktop checks auth generation
  after the HTTP response and discards a result if the account changed while the
  request was in flight. Failed sync submission cancels its unused queued job.
- Weight labels with gram units normalize to kilograms (`0-500 gm` becomes
  `0kg-0.5kg`), and categories normalize case/whitespace before scope matching,
  avoiding false removals and duplicate active rows.
- Database-backed brand cards now include FSN, SKU and order count from the
  matching marketplace/category/brand/seller account partition. Scrape
  normalization keeps sample SKUs tied to that same group.
- The log renderer no longer treats “incomplete” as success, and its detail
  section only adds removed slabs or summary records that are not already
  visible in the fee rows.

Local verification on the pending follow-up commit: backend **625 passed, 2
skipped** across 90 test files; desktop **4 staging + 70 runtime + 9 E2E + 19
browser-safety checks passed**; the desktop auth suite passed **8 checks**; the frontend production build passed. Windows
installed-package acceptance and Linux AppImage acceptance are still required
for this final source commit and will be checked through the PR workflows before
merge.

The incremental CodeAnt review also surfaced two category-selection gaps: the
Electron start path could drop saved verticals when the renderer omitted an
override, and a brand-specific run could be required to cover categories where
that brand has no database FSN. Both desktop entry points now use the same
selection rule: saved verticals scope the search; all-brand runs require the
selected categories, while brand-specific runs only require explicitly chosen
categories. `forceUpdate` remains a no-op for identical rates by design, because
rewriting unchanged rows would violate the publication invariant. The desktop
E2E suite now asserts this behavior for legacy `forceUpdate: true` callers.
