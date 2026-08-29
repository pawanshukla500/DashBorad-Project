import { describe, expect, it, vi } from 'vitest';
import { mountApiRoutes } from '../routes/index.js';
import { mutationAccessGuard } from '../utils/authMiddleware.js';

describe('API route structure', () => {
  it('mounts statement routes in their frontend namespace', () => {
    const app = { use: vi.fn() };
    mountApiRoutes(app);

    const statementCalls = app.use.mock.calls.filter(([path]) => path === '/api/statement');
    expect(statementCalls).toHaveLength(2);
    expect(statementCalls[0][1]).toBe(mutationAccessGuard);
  });

  it.each(['/api/amazon-fc', '/api/disputes', '/api/upload', '/api/mp-settlement'])(
    'protects mutations under %s',
    (path) => {
      const app = { use: vi.fn() };
      mountApiRoutes(app);
      const firstCall = app.use.mock.calls.find(([mountedPath]) => mountedPath === path);
      expect(firstCall?.[1]).toBe(mutationAccessGuard);
    },
  );

  it('keeps detailed financial exports behind the analyst-or-above boundary', () => {
    const app = { use: vi.fn() };
    mountApiRoutes(app);

    const exportCalls = app.use.mock.calls.filter(([path]) => path === '/api/export');
    expect(exportCalls).toHaveLength(2);
    // The first export mount is a role middleware, followed by the router.
    const accessGuard = exportCalls[0][1];
    const denied = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; } };
    accessGuard({ user: { role: 'viewer' } }, denied, vi.fn());
    expect(denied.statusCode).toBe(403);

    const next = vi.fn();
    accessGuard({ user: { role: 'analyst' } }, denied, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
