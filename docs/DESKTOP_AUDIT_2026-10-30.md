# Desktop browser and rate-card audit — 30 October 2026

Scope: merged PRs #73–#77, Electron and standalone desktop entry points,
browser adapter, sessions, scraper, staging, publisher, PostgreSQL schemas,
Linux service installer, release preparation and all three Actions workflows.
Baseline commit: `cf7d49a8663b581237e3f1f47d25f5e663af9547`.
No deployment, merge, schema migration or production rate-card writes are authorized.

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
  Reloading the accepted search hash is necessary to obtain fresh fees.
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
selectors only against authenticated captures. Keep PR draft until required checks
and actual packaged Windows/Linux evidence pass; do not merge before CodeAnt
reviews every commit. Production migration/publication requires separate approval.

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
- Backend: 87 files / 609 tests passed; isolated real PostgreSQL integration
  is skipped locally without an explicit loopback fixture database and runs in CI.
- Desktop: 4 SQLite + 67 runtime + 9 E2E + 10 safety tests passed.
- Frontend production build passed in 6.76 seconds.
- Installed-package acceptance is being run. Compilation and unit tests alone
  do not establish Windows/Linux installed runtime success.

No release tag, deployment, production migration, merge, or production rate
publication was performed.
