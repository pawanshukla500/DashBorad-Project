import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(new URL('../../.github/workflows/deploy-hostinger.yml', import.meta.url), 'utf8');

describe('production deployment approval gate', () => {
  it('runs CI on master pushes but requires a manual dispatch to deploy', () => {
    expect(workflow).toContain('push:');
    expect(workflow).toContain('branches: [master]');
    expect(workflow).toContain("if: github.ref == 'refs/heads/master' && github.event_name == 'workflow_dispatch'");
    expect(workflow).not.toContain("github.event_name == 'push' || github.event_name == 'workflow_dispatch'");
  });
});
