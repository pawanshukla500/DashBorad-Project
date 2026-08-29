# ReconCentral — Stitch Design Brief

## Primary Stitch prompt (copy everything below)

Design a polished, desktop-first, responsive B2B financial SaaS product called **ReconCentral**. It helps Indian marketplace sellers reconcile orders, returns, fees, settlements, payouts, and profit across Flipkart, Amazon, Myntra, and other marketplaces.

The product must feel trustworthy, calm, precise, and premium—more like a modern financial control room than an e-commerce storefront. Avoid generic gradients, noisy dashboards, glassmorphism, and overly playful illustrations. Use spacious, information-rich cards, clear hierarchy, excellent data legibility, and accessible contrast.

### Brand

- **Product name:** ReconCentral
- **Tagline:** *Know every payout. Reconcile every rupee.*
- **Short promise:** One clear view of marketplace money, exceptions, and profitability.
- **Audience:** Marketplace finance teams, founders, operators, accountants, and reconciliation analysts.

### Logo direction

Create a compact brand system, including a logo mark, wordmark, favicon/app icon, and monochrome version.

- Make the mark an abstract, simple **R + C / reconciliation** symbol: two precise interlocking ledger lines, a subtle matched-pair/check motif, or a circular comparison mark. It should work at 20 px in a sidebar and at large sizes on the login page.
- Use rounded geometry with confident straight lines; it should communicate matching, clarity, and financial control.
- Primary logo color: indigo with a restrained teal accent. Do not use a literal rupee, dollar sign, shopping bag, or marketplace logo in the brand mark.
- Wordmark: `ReconCentral` in a modern geometric sans-serif, with “Recon” slightly stronger than “Central”.
- App icon: logo mark on an indigo rounded-square background.

### Visual system

Use Inter, Geist, or a similarly clean sans-serif. Financial values must use tabular numerals. The style should be crisp and professional with subtle 1 px borders and soft shadows only where useful.

| Token | Suggested value | Usage |
| --- | --- | --- |
| Ink | `#0F172A` | Primary text, navigation |
| Slate | `#475569` | Secondary text |
| Canvas | `#F8FAFC` | Page background |
| Surface | `#FFFFFF` | Cards, panels, inputs |
| Border | `#E2E8F0` | Dividers and card borders |
| Primary Indigo | `#4F46E5` | Primary actions, active states |
| Primary Dark | `#3730A3` | Hover/pressed primary states |
| Teal | `#0F9F8C` | Reconciled/success accent |
| Success | `#059669` | Positive money/status |
| Warning | `#D97706` | Attention/partial match |
| Danger | `#E11D48` | Exceptions/negative status |

- Use a 4/8 px spacing rhythm; cards generally have 20–24 px padding and 12–16 px corner radius.
- Charts should use indigo as the lead series, teal for reconciled/positive, amber for pending, and rose for discrepancies.
- Keep all text and controls WCAG AA accessible. Do not rely on color alone for status; pair it with a label/icon.
- Display currency in INR, e.g. `₹12,84,560`, and use `K`, `L`, and `Cr` only where useful. Use Indian number grouping.

### Global application layout

Create a desktop layout for 1440 px wide screens and a mobile adaptation for 390 px wide screens.

- **Left sidebar (desktop):** 248 px, white, thin right border. At the top place the app icon and `ReconCentral` wordmark. Include primary navigation with simple line icons: Overview, Sales, Returns, Payment Check, Statements, Profitability, Cash Flow, Insights, Data Center, Rate Cards, and Admin. The active item has a pale indigo background, indigo icon/text, and a slim indigo left indicator.
- **Top bar:** page title and breadcrumb on the left; global filters on the right for Marketplace, Brand/Business, and Date range. Also include search/command icon, notification icon, help icon, and an avatar menu.
- **Main canvas:** light slate page background with white cards. Use a max-width content frame and generous whitespace.
- **Mobile:** collapse sidebar into a drawer; retain logo, page title, filters, and one primary action. Tables become stacked cards or horizontally scrollable only when necessary.

### Core dashboard: “Financial Control Room”

Design the default authenticated screen, named **Overview**. Make it feel immediately useful for a finance operator arriving each morning.

1. Header: `Good morning, Pawan` / `Financial overview` with a small last-updated state and a `Refresh data` control.
2. Filter row: marketplace multi-select, date range set to `This month`, and a compact comparison toggle (`vs previous period`).
3. Four primary KPI cards in one row:
   - Gross Sales — `₹12,84,560` — `+12.4% vs last month`
   - Bank Received — `₹10,96,240` — `85.3% of expected`
   - Marketplace Fees — `₹1,18,320` — `9.2% of sales`
   - Needs Attention — `18 payouts` — `₹74,890 at risk`
4. Each KPI should include a small contextual icon, compact sparkline, clear positive/negative state, and a restrained hover affordance.
5. Main content row:
   - **Expected vs received**: polished line/area chart with settlement dates on the x-axis and INR amounts on the y-axis.
   - **Reconciliation health**: circular progress/ring showing `94.6% reconciled`, with breakdown pills for Matched, Partial, Pending, and Disputed.
6. Bottom row:
   - **Exception inbox**: a prioritized list of 5 payout discrepancies with marketplace badge, amount, age, reason, and `Review` action.
   - **Marketplace performance**: compact table or ranked bars for Amazon, Flipkart, Myntra, and Meesho, showing sales, fees, payout status, and trend.
7. Add a visible but unobtrusive empty-state alternative: `Connect a marketplace or upload a statement to see your financial picture.` with `Upload statement` as the main CTA.

### Login page (must be included)

Create a beautiful, production-ready login experience for ReconCentral.

#### Desktop composition

- Use a two-column layout. The left 45% is a deep indigo brand panel; the right 55% is a clean off-white authentication area.
- **Left brand panel:** place the logo/wordmark at top, a confident headline such as `Every payout, clearly accounted for.`, one short supporting paragraph, and a tasteful abstract reconciliation visual. The visual can show layered ledger rows converging into matched check marks, small market data bars, and a settlement flow—abstract, not a busy illustration.
- Under the visual, show three concise proof points with line icons: `Multi-marketplace visibility`, `Faster reconciliation`, and `Profit clarity`.
- Add a discreet bottom note: `Built for modern marketplace finance teams`.
- **Right side:** center a white login card with subtle border/shadow, max width about 440 px. Include a small mobile-visible logo above it, `Welcome back`, and `Sign in to continue to ReconCentral`.
- Inputs: work email, password with show/hide control, `Remember me` checkbox, `Forgot password?` link, full-width indigo `Sign in` button, and a divider followed by optional `Continue with Google` outline button.
- Include a small locked/security note below the form: `Your financial data is encrypted and protected.`
- Add clear validation/error states, loading button state, keyboard focus styles, and a link for `Contact support` rather than a distracting sign-up path.

#### Login behavior and states

- Empty/default state, invalid email state, incorrect-password state, disabled/loading sign-in state, and password-reset confirmation state.
- Preserve the typed email when an error occurs. Place inline error text directly below the relevant field.
- On mobile, show the logo and short headline above the form; hide the large decorative visual but retain the proof of security.

### Key product screens to design

Create a coherent high-fidelity system for these screens using the same layout, tokens, and components.

1. **Payment Check / Reconciliation**
   - Settlement summary KPIs: Expected, Received, Difference, and Pending.
   - A dense but readable payout table with marketplace, settlement ID, period, expected amount, received amount, variance, match status, and action menu.
   - Status chips: Matched, Partial match, Pending, Disputed.
   - Detail drawer showing order count, fee components, return deductions, and an audit timeline.

2. **Data Center / Uploads**
   - A clear upload dashboard with marketplace tabs.
   - Large drag-and-drop statement upload area, accepted file information, parse progress, mapping review, success, and parse-error states.
   - A recent imports table showing file name, marketplace, period, rows processed, uploaded by, timestamp, and status.
   - Make it obvious that uploads feed reconciliation without using technical jargon.

3. **Rate Cards**
   - Rules/settings interface for commission, shipping, payment gateway, return, and fixed charges.
   - Side-by-side rate-card list and editable rule detail panel.
   - Use effective dates, marketplace/brand scope, clean form controls, and a warning when unsaved changes exist.

4. **Profitability**
   - Contribution waterfall or stacked bar from gross sales through refunds, marketplace fees, shipping, advertising, and net profit.
   - Product/category table with revenue, deductions, contribution, margin, and trend.
   - Insight callout such as `Fees increased 1.8% for Amazon this month.`

5. **Exception Inbox**
   - Queue-style view with filter chips, severity, owner, status, and due date.
   - Strong visual distinction between urgent exceptions and normal follow-ups without making the screen alarming.

### Components and interaction details

- Use cards, compact status chips, segmented controls, tooltips, empty states, skeleton loaders, toasts, dropdown filters, data tables, charts, drawers, and confirmation dialogs.
- The primary CTA is indigo filled; secondary actions are neutral outline or text buttons. Destructive actions must be rose/red and require confirmation.
- Use icon-only buttons only when universally recognizable, always with tooltip/accessible label.
- Tables must have sticky headers where appropriate, sensible row density, sortable columns, filters, pagination, and visible export action for analysts.
- Design all chart tooltips and loading states. If data is stale, retain the previous values and display a subtle `Last updated ...` indicator—never replace real data with fake zeros.
- Animate KPI number changes with a 450–560 ms ease-out count-up, but only when a value genuinely changes. Keep the currency prefix/suffix stable, use tabular figures to prevent layout shift, and respect reduced-motion preferences by updating instantly.

### Content tone

- Clear, factual, and finance-friendly. Prefer `₹74,890 needs review` over vague labels like `Something is wrong`.
- Use realistic sample values, but label sample data clearly when it is not live.
- Avoid excessive jargon, all-caps labels, or marketing-heavy copy in the authenticated product.

### Expected deliverables from Stitch

Produce:

1. A logo mark, wordmark, app icon, and monochrome logo treatment for ReconCentral.
2. High-fidelity desktop screens for Login, Overview Dashboard, Payment Check, Data Center, Rate Cards, Profitability, and Exception Inbox.
3. Responsive mobile designs for Login, Overview, and Payment Check.
4. A reusable component library: buttons, fields, sidebar, top bar, cards, KPI cards, status chips, tables, filters, chart styles, empty states, and alerts.
5. A clickable prototype for: Login → Overview → Payment Check detail → Upload statement.
6. A concise design-token page with color, typography, spacing, radius, shadows, and status-color usage.

## Optional one-line prompt for a new Stitch project

`Create ReconCentral, a premium Indian marketplace finance reconciliation SaaS. Design a compact reconciliation logo and an accessible responsive UI with a two-column login page, a financial-control-room dashboard, settlement reconciliation, statement uploads, rate cards, profitability, and exception management. Use a calm indigo/teal financial visual system, Inter-style typography, INR values, clear data tables, polished charts, and strong loading/error/empty states.`

## Implementation handoff notes

- The existing application uses `/logo.png`; replace it with the final exported logo asset from the Stitch design.
- Keep logo assets available as SVG for the app icon, sidebar, light/dark use, and favicon.
- Export desktop screens at 1440 px wide and mobile screens at 390 px wide.
- Ensure all major interactive states have a design: hover, focus, disabled, loading, success, empty, validation error, and data error.
