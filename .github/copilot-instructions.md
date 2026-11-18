## Mandatory agent bootstrap (read first)

This repository requires every agent to follow
[AGENTS.md section 0](../AGENTS.md#0-mandatory-agent-bootstrap-graphify--ponytail):

1. Bootstrap the tooling first: `npm run agent:bootstrap` (first run) or
   `npm run agent:check` (every session).
2. Query the graphify knowledge graph before reading or searching code (rules below).
3. Apply the ponytail ruleset in AGENTS.md section 0.3: the smallest complete
   change; never cut validation, error handling, security or accessibility.
4. After changes, run `npm run graph:update` and update AGENTS.md / GEMINI.md and
   the owning docs (AGENTS.md section 0.4). Guide: `docs/AGENT_TOOLING.md`.

The graph is code-only and offline (`GRAPHIFY_BACKEND=none`); this repository is
public, so never run a graphify LLM backend over it or commit `graphify-out/`.

## graphify

For any question about this repo's architecture, structure, components, or how to add/modify/find
code, your first action should be `graphify query "<question>"` when `graphify-out/graph.json`
exists. Use `graphify path "<A>" "<B>"` for relationship questions and `graphify explain "<concept>"`
for focused-concept questions. These return a scoped subgraph, usually much smaller than the full
report or raw grep output.

Triggers: "how do I…", "where is…", "what does … do", "add/modify a <component>",
"explain the architecture", or anything that depends on how files or classes relate.

If `graphify-out/wiki/index.md` exists, use it for broad navigation. Read `graphify-out/GRAPH_REPORT.md`
only for broad architecture review or when query/path/explain do not surface enough context. Only read
source files when (a) modifying/debugging specific code, (b) the graph lacks the needed detail, or
(c) the graph is missing or stale.

Build or update the graph with `npm run graph:update` (code-only, offline). Do not run the `/graphify` semantic pass on this repo: it sends docs to an LLM.
