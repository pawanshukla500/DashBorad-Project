import { describe, expect, it, vi } from 'vitest';
import {
  forEachDbBatch,
  QUERY_PARAMETER_BUDGET,
  safeBatchSize,
  UPLOAD_BATCH_SIZE,
} from '../utils/dbBatch.js';

describe('database upload batching', () => {
  it('targets 5,000 rows for narrow writes', () => {
    expect(UPLOAD_BATCH_SIZE).toBe(5000);
    expect(safeBatchSize(1)).toBe(5000);
    expect(safeBatchSize(4)).toBe(5000);
  });

  it('automatically reduces wide writes below the parameter budget', () => {
    expect(safeBatchSize(20)).toBe(3000);
    expect(safeBatchSize(41)).toBe(Math.floor(QUERY_PARAMETER_BUDGET / 41));
  });

  it('processes every row once in ordered chunks', async () => {
    const rows = Array.from({ length: 10001 }, (_, index) => index);
    const sizes = [];
    const handler = vi.fn(async batch => sizes.push(batch.length));

    await forEachDbBatch(rows, 1, handler);

    expect(sizes).toEqual([5000, 5000, 1]);
    expect(handler).toHaveBeenCalledTimes(3);
  });
});
