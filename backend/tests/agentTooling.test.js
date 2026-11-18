import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { compareVersions, MIN_GRAPHIFY_VERSION, PONYTAIL_REPO } from '../../scripts/agent-bootstrap.mjs';

// The audited upstream commit: pinned in .claude/settings.json and named in AGENTS.md 0.3.
const PONYTAIL_COMMIT = '96608e078b2d5ea607c5c3b8b5a54d1c1fba6846';
const root = path.resolve('..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const section0 = text => text.slice(text.indexOf('## 0. Mandatory Agent Bootstrap'), text.search(/\n## (TaskFlow Pro Integration|Mandatory Workflow: TaskFlow Pro Integration)/));

describe('agent tooling bootstrap (graphify + ponytail)', () => {
  it('compares graphify versions numerically, not as text', () => {
    expect(compareVersions('0.9.112', '0.9.112')).toBe(0);
    expect(compareVersions('0.9.112', '0.9.103')).toBe(1);
    expect(compareVersions('0.9.99', '0.9.112')).toBe(-1);
    expect(compareVersions('1.0', '0.9.200')).toBe(1);
    expect(compareVersions(MIN_GRAPHIFY_VERSION, '0.9.112')).toBeGreaterThanOrEqual(0);
  });

  it('declares the ponytail plugin and the session bootstrap for Claude Code', () => {
    const settings = JSON.parse(read('.claude/settings.json'));
    expect(settings.extraKnownMarketplaces.ponytail.source).toEqual({ source: 'github', repo: PONYTAIL_REPO, ref: PONYTAIL_COMMIT });
    expect(settings.enabledPlugins['ponytail@ponytail']).toBe(true);
    const sessionCommands = settings.hooks.SessionStart.flatMap(entry => entry.hooks.map(hook => hook.command));
    expect(sessionCommands).toContain('node "$CLAUDE_PROJECT_DIR/scripts/agent-bootstrap.mjs" --session');
    const guards = settings.hooks.PreToolUse.flatMap(entry => entry.hooks.map(hook => hook.command));
    // Each guard is a no-op where graphify is not installed, so a fresh clone gets no hook errors.
    const guarded = mode => `command -v graphify >/dev/null 2>&1 || exit 0; graphify hook-guard ${mode}`;
    expect(guards).toEqual(expect.arrayContaining([guarded('search'), guarded('read')]));
    expect(sessionCommands).toContain(guarded('compact'));
  });

  it('keeps committed agent config portable (no machine-specific executable paths)', () => {
    for (const file of ['.claude/settings.json', '.gemini/settings.json']) {
      expect(read(file), file).not.toMatch(/[A-Za-z]:[\\/]|\/Users\/|\.EXE/i);
    }
    expect(fs.existsSync(path.join(root, '.codex/hooks.json'))).toBe(false);
  });

  it('carries the same section 0 in AGENTS.md and GEMINI.md, with the ponytail ruleset and docs rule', () => {
    const agents = section0(read('AGENTS.md'));
    const gemini = section0(read('GEMINI.md')).replace('\n> Mirror of `AGENTS.md` section 0, which is canonical. Change both together.\n', '');
    expect(agents.length).toBeGreaterThan(2000);
    expect(gemini).toBe(agents);
    for (const required of [
      'npm run agent:bootstrap',
      'GRAPHIFY_BACKEND=none',
      'Never cut: validation at trust boundaries',
      '### 0.4 Keep project context and documentation current',
      PONYTAIL_COMMIT,
    ]) {
      expect(agents).toContain(required);
    }
  });

  it('ships the vendored ponytail skills with their licence and keeps local noise out of the graph', () => {
    for (const skill of ['ponytail', 'ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help']) {
      expect(fs.existsSync(path.join(root, '.agents/skills', skill, 'SKILL.md')), skill).toBe(true);
    }
    expect(read('.agents/skills/ponytail/LICENSE')).toMatch(/^MIT License/);
    for (const dir of ['.claude/skills/graphify', '.agents/skills/graphify']) {
      expect(read(`${dir}/LICENSE`), dir).toContain('Apache License');
      expect(read(`${dir}/NOTICE`), dir).toContain('Graphify');
    }
    const ignore = read('.graphifyignore');
    for (const entry of ['scratch/', 'released/', 'graphify-out/', '**/*.xlsx']) expect(ignore).toContain(entry);
    expect(read('.gitignore')).toMatch(/^graphify-out\/$/m);
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['agent:bootstrap']).toBe('node scripts/agent-bootstrap.mjs');
    expect(pkg.scripts['agent:check']).toBe('node scripts/agent-bootstrap.mjs --check');
  });
});
