# ReconCentral RateCard Desktop 1.8.16 — Delivery Notes

Date: 2026-11-04. Scope: reliable fee-change detection, publish validation,
approval notifications, updater consent, and a light-first desktop UI.
The working scraper, browser sessions, and comparison architecture are preserved.

## What changed

### P0-1 — Publish path unblocked (was 100% broken)
- `backend/db/rateCardDimensionalMigration.js` (new, versioned `2026.10.ratecard-worker-jobs-3`,
  wired in `ensureRateCardWorkerSchema`): adds the dimensional columns the publish
  readiness gate requires (`weight_min/max`, `base_weight`, `increment_weight`,
  `*_additional_fee` on `rc_reverse_shipping`; plus `local/zonal/national_fee`,
  `price_scope` on `rc_pick_pack`), backfills them, and creates the three missing
  portal-active unique indexes (`rc_commission_uniq_portal_active`,
  `rc_reverse_shipping_uniq_portal_active`, `rc_pick_pack_uniq_portal_active`).
  Also adds a `NOT VALID` CHECK enforcing the Shopsy 0%-commission policy for open rows (closed history stays closable via an `end_date` escape).
- Before: every publish failed with `RATE_SCHEMA_NOT_READY`. After: gate requirements
  are satisfiable (5 indexes + 21 columns).
- Test: `backend/tests/rateCardDimensionalMigration.test.js` (6 tests).

### P0-2 — Desktop DB parity
- `desktop/db.js` allowlist now includes `rc_pick_pack` and `rc_franchise_fee`
  (covers all six backend rate tables + versions).
- Test: `desktop/tests/test_db_allowlist.js`, wired into `desktop` `npm test`.

### P0-3 — Updater consent + scraper safety
- `autoDownload=false`, `autoInstallOnAppQuit=false`; new `update-download` IPC
  (public channel, pre-sign-in safe). Banner offers **Update Now / Later**;
  Later defers per version, re-prompts on a new version.
- `update-install` refuses while a scrape, worker job, or publication runs.
- `desktop/tests/test_desktop_runtime.js` updated to the consent contract (76/0).

### P1 — Publish notifications + settlement recalc
- `rateCardPublisher` sends an anomaly-aware Resend email after COMMIT
  (`version_published`, never rolls back rates on failure) and refreshes
  `order_settlement_totals` so fee changes recalculate economics.
- Desktop stages `changesCount/anomaliesCount` with the review and shows a native
  Notification on publish (flagged wording when anomalies exist).
- Anomaly banner now explains impact by change type (new fees add cost, removals
  eliminate it, modifications need margin review).
- Test: publish-side-effects case in `rateCardPortalIntegrity.test.js`.

### P2 — Light-first UI
- `desktop/ui/style.css` rewritten on CSS variables: light default, dark opt-in via
  `data-theme="dark"`, persisted as `uiTheme` in app config, header toggle included.
- All views converted (Dashboard, Live Browser, Scraper Logs, Rate Comparison,
  Notifications, Settings, Excel, auth modal, banners, tables, forms).
- Deliberately dark surfaces kept: terminal console, browser viewport frame,
  dim overlays. Focus ring stays brand `#902A4A`; contrast pairs verified
  (`--success/warning/danger-strong` text variants).
- Screenshots: `docs/ratecard-ui/light-dashboard.png`, `dark-dashboard.png`.

## Test evidence
- Backend vitest: 94 files passed, 1 skipped file; 680 tests passed, 8 skipped.
- Desktop: runtime 76/0, node:test suites 107/107, catalog/staging/allowlist green.
- UI verified by headless-Chrome screenshots in both themes (pixels inspected).

## Remaining / not done
- `reconcileOrder` still covers commission/fixed/collection only (threshold 2);
  reverse/pick-pack/franchise excluded — documented, unchanged.
- Coverage stays Flipkart/Shopsy (worker CLI exits Phase-2 for other portals).
- `released/` root 1.8.3 duplicates and `desktop/dist-release/latest.yml` staleness
  left untouched (no deletions of existing artifacts); Linux AppImage has no
  auto-update feed by design (Windows-only `latest.yml`).
- No production fee changes published; no merge performed by this change set.
