## Summary
Fixes the bright-indigo brand colour on every Save / focus / chip element across the dashboard (ReconCentral primary should be burgundy `#902A4A`) and unclips the brand-name chips in the rate card popup.

## 1. Brand color: indigo to burgundy
`tailwind.config.js` had `primary: "#3525cd"` and `primary-container: "#4f46e5"` — bright indigo. The brand burgundy was only used inline on a handful of pages (`focus:border-[#902A4A]`, `text-[#902A4A]`, etc.) so every `bg-primary` / `text-primary` / `ring-primary` / `border-primary` element on every page rendered in the wrong colour and fought the brand identity.

Updated the primary palette to burgundy:

| Token | Before | After |
|---|---|---|
| primary | #3525cd | #902A4A |
| primary-container | #4f46e5 | #fbe9f0 |
| primary-fixed | #e2dfff | #fbe9f0 |
| primary-fixed-dim | #c3c0ff | #f8b4c8 |
| on-primary-fixed | #0f0069 | #902A4A |
| on-primary-fixed-variant | #3323cc | #902A4A |
| on-primary-container | #dad7ff | #902A4A |
| inverse-primary | #c3c0ff | #f8b4c8 |
| surface-tint | #4d44e3 | #902A4A |
| indigo-dark | #3730A3 | #5d1530 |

Single-source-of-truth fix — every primary-coloured element on every page, every component, every modal now reads as burgundy.

## 2. Brand chips unclip
MultiBrandSelect clipped brand names at 100 px ("Ethnic Junction" was cut). Bumped to 200 px, added a 15% burgundy border for definition on the light-burgundy background, swapped the wrong `text-indigo-400` close-button token for `text-primary/50 hover:text-primary`, added `aria-label="Remove {brand}"` for screen readers, and bumped chip text from 10 px to 11 px to match the design system.

## Verification
- `vite build` OK 4.68 s
