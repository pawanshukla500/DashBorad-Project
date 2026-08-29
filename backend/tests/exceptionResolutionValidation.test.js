import { describe, expect, it } from 'vitest';
import { parseExceptionResolutionInput } from '../routes/exceptions.js';

describe('exception resolution validation', () => {
  it('accepts only known state transitions with bounded notes', () => {
    expect(parseExceptionResolutionInput('upload:42', { status: 'resolved', note: 'Source file corrected' }))
      .toEqual({ key: 'upload:42', status: 'resolved', note: 'Source file corrected' });
  });

  it('does not turn an unrecognized state into open', () => {
    expect(() => parseExceptionResolutionInput('upload:42', { status: 'closed' }))
      .toThrow('status must be open or resolved');
    expect(() => parseExceptionResolutionInput('', { status: 'open' }))
      .toThrow('exception key must contain');
  });
});
