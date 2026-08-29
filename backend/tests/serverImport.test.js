import { describe, expect, it } from 'vitest';
import { app, startServer } from '../server.js';

describe('server entrypoint', () => {
  it('imports the complete route graph without syntax errors or starting a listener', () => {
    expect(app).toBeTypeOf('function');
    expect(app.listening).not.toBe(true);
    expect(startServer).toBeTypeOf('function');
  });
});
