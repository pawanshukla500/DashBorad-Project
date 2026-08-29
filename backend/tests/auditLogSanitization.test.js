import { describe, expect, it } from 'vitest';
import { sanitizeAuditDetails } from '../services/auditLog.js';

describe('audit detail sanitization', () => {
  it('redacts nested secrets and binary payloads while retaining useful context', () => {
    const sanitized = sanitizeAuditDetails({
      requestId: 'req-100',
      fileName: 'settlement.xlsx',
      payload: {
        authorization: 'Bearer secret-token',
        apiKey: 'key-123',
        upload: Buffer.from('spreadsheet-bytes'),
      },
    });

    expect(sanitized).toMatchObject({
      requestId: 'req-100',
      fileName: 'settlement.xlsx',
      payload: {
        authorization: '[redacted]',
        apiKey: '[redacted]',
        upload: '[binary omitted]',
      },
    });
  });

  it('bounds overly large and circular request bodies', () => {
    const cyclic = { note: 'x'.repeat(1_050) };
    cyclic.self = cyclic;
    const sanitized = sanitizeAuditDetails(cyclic);

    expect(sanitized.note).toContain('[truncated 50 characters]');
    expect(sanitized.self).toBe('[circular reference omitted]');
  });
});
