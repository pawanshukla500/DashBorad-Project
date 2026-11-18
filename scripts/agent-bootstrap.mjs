#!/usr/bin/env node
// Agent bootstrap for ReconCentral (DashBorad Project).
//
// Every coding agent (Claude Code, Codex, Gemini CLI / Antigravity, Cursor,
// Copilot, or any other) runs this FIRST in a session, as AGENTS.md section 0
// requires. It makes the two mandatory agent tools ready:
//
//   graphify  - local, code-only knowledge graph of this repo (graphify-out/),
//               queried before any broad grep / file read.
//   ponytail  - "lazy senior dev" ruleset and skills: smallest complete change,
//               never cutting validation, error handling or security.
//
// Usage:
//   node scripts/agent-bootstrap.mjs            full: install/upgrade, build/update graph, hooks, plugins
//   node scripts/agent-bootstrap.mjs --check    report only; exit 1 when something is missing
//   node scripts/agent-bootstrap.mjs --session  quick, for session-start hooks: refresh graph, print
//                                               reminders, never install, never fail the session
//   flags: --no-hooks (skip git hooks)  --no-plugins (skip agent-CLI plugin installs)
//          --force-graph (full code-only rebuild)
//
// Privacy: the graph is built with GRAPHIFY_BACKEND=none and --code-only, so
// nothing is sent to an LLM provider. This repository is public; never commit
// graphify-out/ (it is git-ignored).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const MODE = args.has('--check') ? 'check' : args.has('--session') ? 'session' : 'full';
const IS_WINDOWS = process.platform === 'win32';
const IN_CI = Boolean(process.env.CI);

// Lowest graphify release this repo's project files were generated with.
export const MIN_GRAPHIFY_VERSION = '0.9.112';
export const GRAPHIFY_PACKAGE = 'graphifyy[sql]';
export const PONYTAIL_REPO = 'DietrichGebert/ponytail';
const GRAPH_ENV = { ...process.env, GRAPHIFY_BACKEND: 'none', PYTHONIOENCODING: 'utf-8' };

const report = [];
const problems = [];
const note = (ok, label, detail) => report.push(`${ok ? 'OK  ' : 'MISS'} ${label}${detail ? ` - ${detail}` : ''}`);

// Commands are fixed strings (never user input). Windows needs the shell to
// resolve npm .cmd shims such as gemini / codex / copilot, so there the
// command line is built once with every argument quoted.
const quoteForCmd = value => (/^[\w@./:=+-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`);

function run(command, commandArgs = [], { timeout = 600_000, env = process.env } = {}) {
  const options = { cwd: ROOT, env, encoding: 'utf8', timeout, windowsHide: true };
  const result = IS_WINDOWS
    ? spawnSync([command, ...commandArgs].map(quoteForCmd).join(' '), { ...options, shell: true })
    : spawnSync(command, commandArgs, options);
  return {
    ok: result.status === 0,
    status: result.status,
    out: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

const onPath = command => run(IS_WINDOWS ? 'where' : 'command', IS_WINDOWS ? [command] : ['-v', command], { timeout: 10_000 }).ok;

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function graphifyVersion() {
  const result = run('graphify', ['--version'], { timeout: 30_000 });
  const match = result.ok && /(\d+\.\d+\.\d+)/.exec(result.out);
  return match ? match[1] : null;
}

function installGraphify() {
  const attempts = [];
  if (onPath('uv')) attempts.push(['uv', ['tool', 'install', '--upgrade', GRAPHIFY_PACKAGE]]);
  if (onPath('pipx')) attempts.push(['pipx', ['install', '--force', GRAPHIFY_PACKAGE]]);
  for (const python of IS_WINDOWS ? ['py', 'python'] : ['python3', 'python']) {
    if (onPath(python)) attempts.push([python, ['-m', 'pip', 'install', '--upgrade', '--quiet', GRAPHIFY_PACKAGE]]);
  }
  for (const [command, commandArgs] of attempts) {
    const result = run(command, commandArgs, { timeout: 900_000 });
    if (result.ok && graphifyVersion()) return `${command} ${commandArgs.join(' ')}`;
  }
  return null;
}

function ensureGraphify() {
  let version = graphifyVersion();
  const current = version && compareVersions(version, MIN_GRAPHIFY_VERSION) >= 0;
  if (!current && MODE === 'full') {
    const how = installGraphify();
    version = graphifyVersion();
    if (how) report.push(`     installed/upgraded graphify via: ${how}`);
  }
  if (!version) {
    note(false, 'graphify CLI', 'not installed. Run: uv tool install "graphifyy[sql]"  (or: pipx install "graphifyy[sql]", or: python -m pip install "graphifyy[sql]")');
    problems.push('graphify CLI missing');
    return null;
  }
  const upToDate = compareVersions(version, MIN_GRAPHIFY_VERSION) >= 0;
  note(upToDate, 'graphify CLI', upToDate ? version : `${version} is older than ${MIN_GRAPHIFY_VERSION}; run: npm run agent:bootstrap`);
  if (!upToDate) problems.push('graphify CLI outdated');
  return version;
}

function graphStats() {
  const file = join(ROOT, 'graphify-out', 'graph.json');
  if (!existsSync(file)) return null;
  try {
    const graph = JSON.parse(readFileSync(file, 'utf8'));
    return { nodes: graph.nodes?.length || 0, links: graph.links?.length || 0, commit: graph.built_at_commit || null };
  } catch {
    return null;
  }
}

function ensureGraph(hasGraphify) {
  if (!hasGraphify) {
    note(false, 'knowledge graph', 'needs the graphify CLI first');
    problems.push('knowledge graph missing');
    return;
  }
  const before = graphStats();
  const rebuild = MODE === 'full' && (!before || args.has('--force-graph'));
  if (rebuild) {
    const extract = run('graphify', ['extract', '.', '--code-only'], { env: GRAPH_ENV, timeout: 1_800_000 });
    if (extract.ok) run('graphify', ['cluster-only', '.', '--no-label'], { env: GRAPH_ENV, timeout: 900_000 });
    else report.push(`     graphify extract failed: ${extract.out.split('\n').slice(-3).join(' | ')}`);
  } else if (before && MODE !== 'check') {
    // Incremental, AST-only: re-parses changed files only.
    run('graphify', ['update', '.'], { env: GRAPH_ENV, timeout: MODE === 'session' ? 150_000 : 900_000 });
  }
  const after = graphStats();
  if (!after) {
    note(false, 'knowledge graph', 'graphify-out/graph.json missing. Run: npm run agent:bootstrap');
    problems.push('knowledge graph missing');
    return;
  }
  note(true, 'knowledge graph', `${after.nodes} nodes, ${after.links} edges${rebuild ? ' (built)' : MODE === 'check' ? '' : ' (updated)'}`);
}

function ensureGitHooks(hasGraphify) {
  if (!hasGraphify || MODE === 'session') return;
  const status = run('graphify', ['hook', 'status'], { timeout: 30_000 });
  const installed = status.ok && /post-commit:\s*installed/i.test(status.out);
  if (!installed && MODE === 'full' && !args.has('--no-hooks') && !IN_CI) {
    const result = run('graphify', ['hook', 'install'], { timeout: 60_000 });
    note(result.ok, 'graphify git hooks', result.ok ? 'installed (graph rebuilds after commit / checkout / merge)' : result.out.split('\n').pop());
    return;
  }
  note(installed, 'graphify git hooks', installed ? 'installed' : 'not installed (optional). Run: graphify hook install');
}

function ensureProjectFiles(hasGraphify) {
  const required = [
    ['.claude/skills/graphify/SKILL.md', 'graphify skill (Claude Code)'],
    ['.agents/skills/graphify/SKILL.md', 'graphify skill (Agent Skills)'],
    ['.agents/skills/ponytail/SKILL.md', 'ponytail skills (Agent Skills)'],
    ['.cursor/rules/ponytail.mdc', 'ponytail rule (Cursor)'],
    ['.cursor/rules/graphify.mdc', 'graphify rule (Cursor)'],
  ];
  const missingGraphifySkill = !existsSync(join(ROOT, required[0][0])) || !existsSync(join(ROOT, required[1][0]));
  if (missingGraphifySkill && hasGraphify && MODE === 'full') {
    run('graphify', ['install', '--project'], { timeout: 120_000 });
    run('graphify', ['install', '--project', '--platform', 'agents'], { timeout: 120_000 });
  }
  for (const [file, label] of required) {
    const ok = existsSync(join(ROOT, file));
    if (!ok) problems.push(`${label} missing`);
    note(ok, label, ok ? file : `${file} missing; restore it from git (git checkout -- ${file})`);
  }
  const agentsMd = existsSync(join(ROOT, 'AGENTS.md')) ? readFileSync(join(ROOT, 'AGENTS.md'), 'utf8') : '';
  const rules = agentsMd.includes('## 0. Mandatory Agent Bootstrap') && agentsMd.includes('## graphify');
  if (!rules) problems.push('AGENTS.md agent rules missing');
  note(rules, 'AGENTS.md agent rules', rules ? 'section 0 + graphify block present' : 'section 0 or the graphify block is missing');
}

function claudePonytail() {
  let declared = false;
  try {
    const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
    declared = settings.enabledPlugins?.['ponytail@ponytail'] === true;
  } catch { /* reported below */ }
  let installed = false;
  try {
    installed = readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8').includes('ponytail@ponytail');
  } catch { /* not installed */ }
  if (!declared) problems.push('ponytail plugin not declared in .claude/settings.json');
  note(declared, 'ponytail (Claude Code)', installed
    ? 'plugin installed'
    : declared
      ? 'declared in .claude/settings.json; accept the install prompt, or type: /plugin marketplace add DietrichGebert/ponytail  then  /plugin install ponytail@ponytail'
      : 'not declared in .claude/settings.json');
}

function otherAgentPonytail() {
  const canInstall = MODE === 'full' && !args.has('--no-plugins') && !IN_CI;
  const agents = [
    {
      cli: 'gemini',
      label: 'ponytail (Gemini CLI / Antigravity)',
      installed: () => existsSync(join(homedir(), '.gemini', 'extensions', 'ponytail')),
      steps: [['gemini', ['extensions', 'install', `https://github.com/${PONYTAIL_REPO}`]]],
    },
    {
      cli: 'codex',
      label: 'ponytail (Codex)',
      installed: () => false,
      steps: [['codex', ['plugin', 'marketplace', 'add', PONYTAIL_REPO]], ['codex', ['plugin', 'add', 'ponytail@ponytail']]],
    },
    {
      cli: 'copilot',
      label: 'ponytail (GitHub Copilot CLI)',
      installed: () => false,
      steps: [['copilot', ['plugin', 'marketplace', 'add', PONYTAIL_REPO]], ['copilot', ['plugin', 'install', 'ponytail@ponytail']]],
    },
  ];
  for (const agent of agents) {
    if (!onPath(agent.cli)) continue;
    if (agent.installed()) {
      note(true, agent.label, 'installed');
      continue;
    }
    if (!canInstall) {
      note(true, agent.label, `CLI found; install with: ${agent.steps.map(([c, a]) => `${c} ${a.join(' ')}`).join(' && ')}`);
      continue;
    }
    // Re-running an install that already exists is harmless; failures are reported, not fatal.
    const results = agent.steps.map(([command, commandArgs]) => run(command, commandArgs, { timeout: 300_000 }));
    const ok = results.every(result => result.ok || /already/i.test(result.out));
    note(ok, agent.label, ok ? 'installed' : results.map(result => result.out.split('\n').pop()).join(' | '));
  }
  note(true, 'ponytail (every other agent)', 'AGENTS.md section 0 ruleset + .agents/skills/ponytail* + .agents/rules/ponytail.md');
}

function main() {
  const version = ensureGraphify();
  ensureGraph(Boolean(version));
  ensureGitHooks(Boolean(version));
  ensureProjectFiles(Boolean(version));
  claudePonytail();
  otherAgentPonytail();

  const header = `[agent-bootstrap] mode=${MODE} root=${ROOT}`;
  const reminders = [
    'Rules (AGENTS.md section 0):',
    '  1. Query the graph before broad grep/reads: graphify query "<question>" | graphify explain "<symbol>" | graphify path "<A>" "<B>"',
    '  2. Apply the Ponytail ruleset: smallest complete change; never cut validation, error handling, security or accessibility.',
    '  3. After code changes: graphify update .   Then update AGENTS.md / GEMINI.md / docs for any behaviour, schema or workflow change.',
  ];
  const output = [header, ...report, ...(problems.length ? [`Missing: ${problems.join('; ')}. Fix with: npm run agent:bootstrap`] : []), ...reminders];
  console.log(output.join('\n'));

  if (MODE === 'session') return 0;
  return problems.length ? 1 : 0;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
