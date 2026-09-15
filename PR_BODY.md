## Summary
Builds an accessible Modal/Dialog primitive and wires the rate-card page to use it for destructive confirmations and success/error feedback, replacing window.confirm / window.alert so the experience stays on-brand, keyboard-accessible, and ARIA-correct.

## New components
- `frontend/src/components/Modal.jsx` — Modal primitive:
  - role="dialog", aria-modal="true", aria-labelledby + aria-describedby wiring
  - Focus trap (Tab / Shift+Tab cycle through focusables)
  - Esc-to-close (configurable)
  - Click-outside-to-close (configurable)
  - Body scroll lock while open
  - Focus restoration to previously focused element on close
  - Smooth fade + scale transition, respects prefers-reduced-motion
  - Five sizes: sm / md / lg / xl / full
  - Header / body / footer slots, optional hideCloseButton, optional initialFocusRef
- ConfirmDialog — composes Modal for destructive confirmations:
  - Two variants: danger (rose) and primary (brand)
  - Replaces window.confirm
  - Built-in spinner + busy state, click-outside + close disabled while busy

## RateCardConfigPage rewires
- **FeeTypeView.handleDeletePeriod** — replaced window.confirm with the styled ConfirmDialog. Sequential delete now also captures per-row failures and surfaces them in a toast banner (e.g. "Deleted 6 of 7 — 1 failed: ...") instead of silently halting mid-loop.
- **AccountStrip.handleRemove** — replaced window.confirm with the styled ConfirmDialog. Errors set the inline addErr chip instead of alert().
- **FeeTypeView banner** — added a success / error toast at the top with auto-dismiss after 4.5 s, ARIA live=polite, manual dismiss button.

## Verification
- `vite build` ✅ 4.88 s

## TaskFlow task
ec718ff7-6833-4ff8-ba88-b15a161310be
