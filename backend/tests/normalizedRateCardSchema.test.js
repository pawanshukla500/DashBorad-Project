import { describe, expect, it } from 'vitest';
import { initDb } from '../db/initDb.js';

describe('normalized rate card schema', () => {
  it('exports initDb properly', async () => {
    expect(typeof initDb).toBe('function');
  });
});
