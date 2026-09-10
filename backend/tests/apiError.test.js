import { describe, expect, it } from 'vitest';
import { publicApiError } from '../utils/apiError.js';
import { DatabaseUnavailableError } from '../db/index.js';

describe('framework API error responses', () => {
  it('returns a retryable service-unavailable response for database outages', () => {
    expect(publicApiError(new DatabaseUnavailableError(new Error('socket closed')))).toEqual({
      status: 503,
      body: {
        error: 'Database connection is temporarily unavailable. Please retry shortly.',
        code: 'DB_UNAVAILABLE',
      },
    });
  });

  it('does not turn oversized uploads into an HTML error page', () => {
    expect(publicApiError({ code: 'LIMIT_FILE_SIZE' })).toEqual({
      status: 413,
      body: { error: 'Request payload exceeds the allowed size.', code: 'PAYLOAD_TOO_LARGE' },
    });
  });

  it('returns a clear JSON validation error for malformed request JSON', () => {
    const error = new SyntaxError('Unexpected token');
    error.status = 400;
    error.type = 'entity.parse.failed';
    error.body = '{bad json';
    expect(publicApiError(error)).toEqual({
      status: 400,
      body: { error: 'Request body must contain valid JSON.', code: 'INVALID_JSON' },
    });
  });

  it('does not expose unhandled internal errors', () => {
    expect(publicApiError(new Error('database password: secret'))).toEqual({
      status: 500,
      body: { error: 'The service could not complete this request. Please retry shortly.', code: 'INTERNAL_ERROR' },
    });
  });

  it('exposes safe public validation errors with status 400', () => {
    const error = new Error('Unsupported file type ".exe". Only spreadsheet files are permitted.');
    error.status = 400;
    error.isPublic = true;
    error.code = 'INVALID_FILE_TYPE';
    expect(publicApiError(error)).toEqual({
      status: 400,
      body: {
        error: 'Unsupported file type ".exe". Only spreadsheet files are permitted.',
        code: 'INVALID_FILE_TYPE',
      },
    });
  });
});
