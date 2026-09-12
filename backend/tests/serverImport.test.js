import { describe, expect, it } from 'vitest';
import { app, startServer } from '../server.js';

describe('server entrypoint', () => {
  it('imports the complete route graph without syntax errors or starting a listener', () => {
    expect(app).toBeTypeOf('function');
    expect(app.listening).not.toBe(true);
    expect(startServer).toBeTypeOf('function');
  });

  it('serves /health and /api/health publicly without requiring an authorization token', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res1 = await fetch(`http://127.0.0.1:${port}/health`);
      expect([200, 503]).toContain(res1.status);
      const json1 = await res1.json();
      expect(json1).toHaveProperty('status');

      const res2 = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect([200, 503]).toContain(res2.status);
      const json2 = await res2.json();
      expect(json2).toHaveProperty('status');
    } finally {
      server.close();
    }
  });
});
