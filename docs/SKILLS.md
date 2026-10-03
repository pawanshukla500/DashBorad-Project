# Skills Roster — `msitarzewski/agency-agents`

ReconCentral adopts role-based skills from the open-source
[`msitarzewski/agency-agents`](https://github.com/msitarzewski/agency-agents)
catalogue (230+ role briefings, 18 divisions). Each skill is a markdown
briefing — a system-prompt + workflow + deliverables template — that we
load into sub-agent sessions for scoped work.

This file is the **source of truth** for which skills ReconCentral uses
and where each one is wired in.

> Skill files are intentionally **not vendored** into the repo. We fetch
> the canonical version on demand from `raw.githubusercontent.com` so we
> inherit upstream improvements without merge friction.

---

## 1. Primary Skills (project-required)

These 13 skills are the ones Pawan explicitly named for the SOR +
security + Notion initiative. Mapping shows the canonical upstream file
(relative path inside the agency-agents repo) and the ReconCentral
sub-system that uses it.

| # | Skill (display) | Canonical path | Used by in ReconCentral |
|---|---|---|---|
| 1 | Frontend Developer | `engineering/engineering-frontend-developer.md` | React + Vite + Tailwind pages (`frontend/src/pages/**`), component primitives, design-token usage |
| 3 | Backend Architect | `engineering/engineering-backend-architect.md` | Express + PostgreSQL services (`backend/services/**`), route structure |
| 3 | AI Engineer | `engineering/engineering-ai-engineer.md` | Email-intelligence parsing pipeline, Gemini rate-card parser, auto-mapping prompts |
| 4 | DevOps Automator | `engineering/engineering-devops-automator.md` | Hostinger VPS Docker deploy, GitHub Actions CI, `.dockerignore`, `START.bat` |
| 5 | Senior Developer | `engineering/engineering-senior-developer.md` | End-to-end feature merges, multi-file refactors, PR review hand-off |
| 6 | Code Reviewer | `engineering/engineering-code-reviewer.md` | Pre-merge review, CodeAnt follow-ups, architecture-level diff feedback |
| 7 | Software Architect | `engineering/engineering-software-architect.md` | Cross-cutting invariants (6-tab Profit Analysis, SOR workspace shape, marketplace discovery) |
| 8 | Data Engineer | `engineering/engineering-data-engineer.md` | Upload ingestion pipelines, `forEachDbBatch`, `refreshOrderSettlementTotals`, settlement rollups |
| 9 | Email Intelligence Engineer | `engineering/engineering-email-intelligence-engineer.md` | Parsing Myntra/AJIO/Zepto/Cocoblu invoice emails and PDF attachments |
| 10 | Database Reliability Engineer | `engineering/engineering-database-reliability-engineer.md` | Postgres schema migrations (`backend/db/initDb.js`), indexes, batch limits, `forEachDbBatch` |
| 11 | UI Designer | `design/design-ui-designer.md` | ReconCentral design system (burgundy `#902A4A`, Inter + Geist + JetBrains Mono, tabular-nums) |
| 12 | UX Researcher | `design/design-ux-researcher.md` | Operator-upload journey, exception inbox triage, SOR portal tab IA |
| 13 | Analytics Reporter | `engineering/engineering-data-visualization-engineer.md` (closest match — there is no dedicated `analytics-reporter.md` upstream) | Dashboard KPIs, Insight cards, SOR seller insights |

> Upstream has a `finance/` division but no explicit analytics-reporter
> role. We substitute `data-visualization-engineer` (covers dashboard
> KPI design + insight storytelling) and tag the SOR tab
> "Analytics Reporter" output as a `design/data-visualization-engineer`
> deliverable until upstream adds a closer match.

---

## 2. Supporting Skills (used as needed)

| Skill | Canonical path | When to load |
|---|---|---|
| AppSec Engineer | `security/security-appsec-engineer.md` | Security audit, OWASP sweep, dependency CVE review |
| Security Architect | `security/security-architect.md` | Threat model for new portal onboarding (e.g. Zepto, Cocoblu) |
| Identity & Access Engineer | `engineering/engineering-identity-access-engineer.md` | Firebase role-claim changes, RBAC matrix edits |
| Privacy Engineer | `engineering/engineering-privacy-engineer.md` | PII handling in settlement + invoice emails |
| FinOps Engineer | `engineering/engineering-finops-engineer.md` | Hostinger cost review + query-cost guardrails |
| Incident Response Commander | `engineering/engineering-incident-response-commander.md` | Severity-1 outage on prod reconciliation |
| UX Architect | `design/design-ux-architect.md` | Multi-Workspace IA changes (e.g. adding SOR workspace) |
| UI Finish-Gate Reviewer | `design/design-ui-finish-gate-reviewer.md` | Final visual QA before merging UI-heavy PRs |
| Brand Guardian | `design/design-brand-guardian.md` | Token drift, color/font regressions |
| Codebase Onboarding Engineer | `engineering/engineering-codebase-onboarding-engineer.md` | First PRs from a new collaborator |

---

## 3. How a skill is loaded

When a sub-agent session is spawned for a scoped task, the parent loads
the skill markdown as the agent's `system_prompt`. Convention:

```text
1. Read the canonical skill file via web_fetch (raw.githubusercontent.com).
2. Strip the leading `---`-fenced YAML frontmatter (name/description/color/emoji).
3. Prepend our local context block:

   You are operating inside ReconCentral (VB Exports, marketplace finance
   reconciliation). Repo: github.com/pawanshukla500/DashBorad-Project.
   Stack: React 18 + Vite + Tailwind, Express + PostgreSQL, Firebase Auth.
   Mandatory invariants — see AGENTS.md (Myntra 10708/45833 split, no
   synthetic AMZ- keys, forEachDbBatch, refreshOrderSettlementTotals,
   6-tab Profit Analysis, vb_export_sku, no .env in VCS).
5. Compose: <local context block> + <skill body>.
6. The resulting prompt is the agent's role briefing.
```

For local-only delegation (e.g. via `task` tool with a custom
`agent_name`), the skill body is pasted into the child session prompt.

---

## 4. Skill ↔ ReconCentral area map

```
Frontend Developer    → frontend/src/pages/SOR/, frontend/src/components/
Backend Architect    → backend/routes/, backend/services/
Data Engineer        → backend/services/ingestion*/, settlement rollups
DB Reliability       → backend/db/initDb.js, backend/db/migrations/
AI Engineer          → backend/services/rateCardScraper.js, email parsers
Email Intelligence   → backend/services/invoiceEmailParser.js (planned)
DevOps Automator     → .github/workflows/, Dockerfile, docker-compose.production.yml
Senior Developer     → cross-file refactors (SOR scaffold, portal onboarding)
Code Reviewer        → pre-merge on every PR
Software Architect   → docs/ARCHITECTURE.md, cross-cutting invariants
UI Designer          → design tokens, Modal/Skeleton/Sidebar primitives
UX Researcher        → operator + analyst journeys, SOR IA
Analytics Reporter   → Dashboard, Insights, SOR overview cards
AppSec Engineer      → every PR with new dependencies, secret/role changes
Security Architect   → threat model for new portal onboarding
```

---

## 5. Maintenance

- Update this file whenever a skill is added/renamed/skipped.
- Any change to `AGENTS.md` must remain compatible with the local-context
  block above (see Step 3.4).
- If upstream adds a closer match for "Analytics Reporter", switch the
  entry in §1.