# Agent Tooling: graphify + ponytail

Every coding agent that works on ReconCentral (Claude Code, Codex, Gemini CLI /
Google Antigravity, Cursor, GitHub Copilot, Kimi, OpenCode, Devin, and their
subagents) uses two tools. The binding rules are in
[`AGENTS.md` section 0](../AGENTS.md#0-mandatory-agent-bootstrap-graphify--ponytail)
(mirrored in [`GEMINI.md`](../GEMINI.md)); this guide explains how they work, what
is installed where, how to upgrade them, and how to fix problems.

| Tool | Role in this repo | Upstream | Licence |
|---|---|---|---|
| **graphify** | Local, code-only knowledge graph of the repo in `graphify-out/`: symbols, call / import edges, communities, god nodes. Agents query it before grepping or reading whole files, which keeps their context small and their answers anchored to the real call graph. | [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify), PyPI package `graphifyy` | Apache-2.0 |
| **ponytail** | "Lazy senior dev" ruleset and skills: smallest complete change, reuse before writing, never cut validation, error handling, security or accessibility; plus `/ponytail-review` and `/ponytail-audit`. | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | MIT |

---

## 1. Quick start

New machine, new agent, or after pulling a change to the tooling:

```bash
npm run agent:bootstrap
```

Every session afterwards (Claude Code does this automatically at session start):

```bash
npm run agent:check
```

After changing code:

```bash
npm run graph:update
```

Requirements: Node 18+ (already required by the app), Python 3.11+ (for
graphify), and optionally `uv` or `pipx` for an isolated graphify install.

---

## 2. What is installed where

### 2.1 Committed to the repository (shared by every clone)

| Path | Written by | Read by |
|---|---|---|
| `AGENTS.md` section 0 + `## graphify` block + `# graphify` registration | hand + `graphify install --project` / `graphify codex install` | Claude Code, Codex, Aider, OpenCode, Amp and most agents |
| `GEMINI.md` section 0 mirror + `## graphify` block | hand + `graphify gemini install` | Gemini CLI, Google Antigravity |
| `.claude/settings.json` | hand + `graphify install --project` | Claude Code (ponytail plugin declaration, `SessionStart` bootstrap check, graphify `PreToolUse` guards) |
| `.claude/skills/graphify/` | `graphify install --project` | Claude Code (`/graphify`) |
| `.agents/skills/graphify/` | `graphify install --project --platform agents` | Agent Skills-compatible agents (Codex, `npx skills`, others) |
| `.agents/skills/ponytail*/`, `.agents/rules/ponytail.md`, `.agents/skills/ponytail/LICENSE` | vendored from ponytail at a pinned commit (section 6) | Agent Skills-compatible agents |
| `.gemini/settings.json` | `graphify gemini install` (command made portable) | Gemini CLI `BeforeTool` guard |
| `.cursor/rules/graphify.mdc`, `.cursor/rules/ponytail.mdc` | `graphify cursor install`, vendored from ponytail | Cursor (always-apply rules) |
| `.github/copilot-instructions.md` | `graphify vscode install` + hand | VS Code Copilot Chat |
| `.graphifyignore` | hand | graphify |
| `scripts/agent-bootstrap.mjs` | hand | everyone (`npm run agent:*`) |

### 2.2 Local only (never committed)

| Path | What it is |
|---|---|
| `graphify-out/` | The graph (`graph.json`, `GRAPH_REPORT.md`, `graph.html`, caches). Git-ignored; each clone builds its own. |
| `.git/hooks/post-*` | graphify git hooks (rebuild after commit / checkout / merge / rewrite), installed by the bootstrap. |
| Python user packages | The `graphify` CLI (`graphifyy[sql]`). |
| `~/.claude/plugins/` | The ponytail Claude Code plugin once a user accepts the install. |
| `~/.gemini/extensions/ponytail`, `~/.copilot/skills/graphify`, Codex / Copilot plugin stores | Per-user installs made by the bootstrap or by hand. |
| `~/.config/ponytail/` | Ponytail's local state (current level, optional cost ledger). |

### 2.3 Per agent

| Agent | graphify | ponytail |
|---|---|---|
| Claude Code (CLI, desktop, web) | `.claude/skills/graphify`, AGENTS.md rules, `PreToolUse` guards in `.claude/settings.json` | Plugin declared in `.claude/settings.json`: accept the prompt, or `/plugin marketplace add DietrichGebert/ponytail` then `/plugin install ponytail@ponytail`; AGENTS.md 0.3 always applies |
| Codex | AGENTS.md rules, `.agents/skills/graphify` | `codex plugin marketplace add DietrichGebert/ponytail` + `codex plugin add ponytail@ponytail` (bootstrap does it when `codex` is on PATH); `.agents/skills/ponytail*` |
| Gemini CLI | GEMINI.md rules, `.gemini/settings.json` guard | `gemini extensions install https://github.com/DietrichGebert/ponytail` (bootstrap does it when `gemini` is on PATH) |
| Google Antigravity | GEMINI.md rules; user skill in `~/.gemini/config/skills/graphify` (`graphify install --platform antigravity`) | `agy plugin install https://github.com/DietrichGebert/ponytail`; GEMINI.md 0.3 |
| Cursor | `.cursor/rules/graphify.mdc` | `.cursor/rules/ponytail.mdc` |
| VS Code Copilot Chat | `.github/copilot-instructions.md`, `~/.copilot/skills/graphify` | `.github/copilot-instructions.md` points to AGENTS.md 0.3 |
| GitHub Copilot CLI | `graphify copilot install` (user-level) | `copilot plugin marketplace add DietrichGebert/ponytail` + `copilot plugin install ponytail@ponytail` (bootstrap does it when `copilot` is on PATH) |
| Any other agent | AGENTS.md section 0.2 | AGENTS.md section 0.3, `.agents/` files |

Hooks are convenience only. A user setting such as `"disableAllHooks": true`
in `~/.claude/settings.json` switches every Claude Code hook off, including the
graphify guards, the session check and ponytail's lifecycle hooks. The written
rules in AGENTS.md / GEMINI.md still bind the agent, which is why they carry
the full ruleset rather than a pointer.

---

## 3. The bootstrap script

`scripts/agent-bootstrap.mjs` (Node, no dependencies, Windows / macOS / Linux).

| Command | Mode | What it does | Exit code |
|---|---|---|---|
| `npm run agent:bootstrap` | full | Installs or upgrades graphify (`uv tool install` → `pipx install` → `python -m pip install`), builds the graph on first run or refreshes it, installs graphify git hooks, restores missing project skills, installs ponytail into agent CLIs found on PATH, prints a report | 1 if anything is still missing |
| `npm run agent:check` | check | Reports only; changes nothing | 1 if anything is missing |
| `npm run graph:update` | session | Refreshes the graph incrementally and prints the rules reminder; never installs | always 0 |

Flags for the full mode: `--no-hooks` (skip git hooks), `--no-plugins` (skip
agent-CLI plugin installs), `--force-graph` (full code-only rebuild). In CI
(`CI` set) the script never installs hooks or plugins.

The Claude Code `SessionStart` hook runs `--session` on `startup`, `resume` and
`clear`, so the agent starts every session with a fresh graph and the
reminder in its context.

---

## 4. graphify in this repo

### 4.1 Commands

```bash
graphify query "where are Myntra payments reset after a delete?"   # scoped subgraph for a question
graphify explain "refreshOrderSettlementTotals"                     # a symbol and its neighbours
graphify path "upsertSkuMasterRows" "vb_sku_master"                  # how two things connect
graphify affected "optionalNumber"                                   # what a change to X can break
graphify god-nodes --top 15                                          # architectural hubs
graphify update .                                                    # incremental AST refresh (no LLM)
```

`query`, `path` and `explain` exit `0` with an answer, `3` for an ambiguous
name (candidates listed), `4` when nothing matches. Raise `--budget` when the
output says it was truncated.

`graphify-out/GRAPH_REPORT.md` summarises god nodes, communities and key paths
for broad architecture work; open `graphify-out/graph.html` in a browser for
the interactive map.

### 4.2 Privacy policy (mandatory)

This repository is **public**, and its history contains business data. The
graph is therefore built **code-only and offline**:

- always `GRAPHIFY_BACKEND=none` and `--code-only` (the bootstrap sets both);
- never a graphify LLM backend, `--mode deep`, `graphify label` with a
  backend, `graphify add <url>`, or the semantic `/graphify` pass over `docs/`,
  PDFs or spreadsheets;
- never commit `graphify-out/` (git-ignored) and never push the graph to a
  remote service (Graphify Cloud, Neo4j, FalkorDB) without the owner's
  explicit approval.

Code files are parsed locally with tree-sitter; nothing leaves the machine.
Communities keep placeholder names (`--no-label`) for the same reason.

### 4.3 What the graph covers

`.gitignore` plus `.graphifyignore` decide the scope: `backend/`,
`frontend/src`, `desktop/`, `scripts/` and the SQL files (via the `sql`
extra). Scratch folders, release binaries, build output, captured HTML/PNG
artefacts and spreadsheets are excluded. Add new generated or local-only
folders to `.graphifyignore` when they appear.

### 4.4 Git hooks

`graphify hook install` adds `post-commit`, `post-checkout`, `post-merge` and
`post-rewrite` hooks that rebuild the graph, and registers a merge driver for
`graph.json`. Check with `graphify hook status`; remove with
`graphify hook uninstall`. After `git pull`, run `npm run graph:update`.

---

## 5. ponytail in this repo

### 5.1 What it changes in an agent's behaviour

Before writing, the agent maps every caller, test, fixture and config its
change must reach, then takes the first option that fully works: skip what
nobody asked for, reuse what the codebase already has, use the standard
library or an installed dependency, and only then write the minimum new code.
It never cuts validation at trust boundaries, error handling that prevents data
loss, security or accessibility, and new non-trivial logic leaves a test. The
full text is AGENTS.md section 0.3.

### 5.2 Skills

| Skill | Use |
|---|---|
| `/ponytail` | Switch level: `lite`, `full` (default), `ultra`, `off` (plugin builds) |
| `/ponytail-review` | Review a change like the engineer who gets paged: bugs, security, load, missing tests, what to cut, including untouched files the change breaks |
| `/ponytail-audit` | Rank the whole repo's risks and say what to fix first |
| `/ponytail-debt` | List shortcut comments (`shortcut: <limit>, <when to upgrade>`) |
| `/ponytail-gain` | Show what ponytail saved |
| `/ponytail-help` | Usage |

### 5.3 What its hooks run (audited 2026-11-18, commit `96608e0`)

The Claude Code / Codex plugin runs small Node lifecycle hooks: they inject the
ruleset at session start and into subagents, track the active level, and map
the repo with `git ls-files`. `ponytail-band-import.js` (started only by
`/ponytail band import`) reads local Claude Code session transcripts to build a
local cost ledger in `~/.config/ponytail/band`. No hook makes a network call.

---

## 6. Upgrading

### 6.1 graphify

```bash
python -m pip install --upgrade "graphifyy[sql]"     # or: uv tool upgrade graphifyy / pipx upgrade graphifyy
graphify install --project
graphify install --project --platform agents
graphify gemini install && graphify cursor install && graphify vscode install
```

Then review the diff before committing:

- the installers may write an absolute path to `graphify.EXE` into
  `.gemini/settings.json` or `.codex/hooks.json`; keep the portable command
  (`graphify hook-guard gemini`) and do not commit `.codex/hooks.json` (the
  Codex hook is an intentional no-op; AGENTS.md carries the guidance);
- keep `.claude/settings.json`'s ponytail and `SessionStart` entries;
- bump `MIN_GRAPHIFY_VERSION` in `scripts/agent-bootstrap.mjs`;
- run `npm run agent:check`.

### 6.2 ponytail

1. Pick the upstream commit: `gh api repos/DietrichGebert/ponytail/commits/main --jq .sha`.
2. Re-vendor at that commit: `skills/<name>/SKILL.md` for the six skills into
   `.agents/skills/<name>/SKILL.md`, `.cursor/rules/ponytail.mdc`,
   `.agents/rules/ponytail.md`, and `LICENSE` into
   `.agents/skills/ponytail/LICENSE`.
3. Diff upstream `AGENTS.md` against AGENTS.md section 0.3, apply the changes
   to both AGENTS.md and GEMINI.md, and update the commit hash there and in
   section 5.3 above.
4. Claude Code users get plugin updates through `/plugin` (marketplace
   `ponytail`).

---

## 7. Keeping project context and documentation current

AGENTS.md section 0.4 is the rule; in practice, at the end of every task:

1. `npm run graph:update`.
2. Changed an invariant, workflow, schema rule, command or test count? Update
   AGENTS.md and mirror it in GEMINI.md.
3. Update the owning doc (`docs/ARCHITECTURE.md`,
   `MARKETPLACE_DATA_UPLOAD_SPEC.md`, `docs/SOR_LEVEL_PAYMENT_RECO.md`, the
   relevant audit ledger, this guide, `README.md`). New subsystem: new doc,
   linked from `README.md` and `docs/ARCHITECTURE.md`.
4. In the PR description, list the context and doc files changed, or say why
   none needed to.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `graphify: command not found` after a pip install on Windows | The Python `Scripts` folder is not on PATH. Use `py -m pip install --user "graphifyy[sql]"` and add `%APPDATA%\Python\Python3XX\Scripts` (or the interpreter's `Scripts`) to PATH, or install `uv` (`winget install astral-sh.uv`) and run `npm run agent:bootstrap` again. |
| `tree_sitter_sql not installed` warning | Install the extra: `python -m pip install "graphifyy[sql]"`. |
| Graph shrank after a refactor and `graphify update` refuses to overwrite | `GRAPHIFY_FORCE=1 graphify update .` or `npm run agent:bootstrap -- --force-graph`. |
| Hook errors in Claude Code / Gemini (`graphify: not found`) | Run `npm run agent:bootstrap`; hooks need `graphify` on PATH. |
| No hooks run at all in Claude Code | `"disableAllHooks": true` in `~/.claude/settings.json`; the rules in AGENTS.md still apply. |
| Ponytail plugin prompt never appears | Trust the folder, or install manually with the two `/plugin` commands in 2.3. |
| `graphify query` answers with unrelated nodes | Name the symbol: `graphify explain "<exact name>"`, or `graphify query "..." --seed <file or symbol>`. |

---

## 9. Removing

```bash
graphify uninstall            # removes graphify from every detected platform (add --purge to delete graphify-out/)
graphify hook uninstall
```

For ponytail, remove the plugin with `/plugin uninstall ponytail@ponytail`
(Claude Code) or the agent's own command, delete `.agents/skills/ponytail*`,
`.agents/rules/ponytail.md`, `.cursor/rules/ponytail.mdc`, the
`extraKnownMarketplaces` / `enabledPlugins` entries in `.claude/settings.json`,
and AGENTS.md / GEMINI.md section 0.3.
