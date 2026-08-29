const MULTIPART_LIMIT_CODES = new Set([
  'LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_PART_COUNT',
  'LIMIT_FIELD_COUNT', 'LIMIT_FIELD_KEY', 'LIMIT_FIELD_VALUE',
]);

/**
 * Translate framework-level failures into the same small JSON shape used by
 * application routes. Route handlers retain their own user-facing validation
 * messages; this function only handles errors that bypass a route handler.
 */
export function publicApiError(error) {
  if (error?.type === 'entity.too.large' || MULTIPART_LIMIT_CODES.has(error?.code)) {
    return {
      status: 413,
      body: { error: 'Request payload exceeds the allowed size.', code: 'PAYLOAD_TOO_LARGE' },
    };
  }
  if (error?.type === 'entity.parse.failed' || (error instanceof SyntaxError && error?.status === 400 && 'body' in error)) {
    return {
      status: 400,
      body: { error: 'Request body must contain valid JSON.', code: 'INVALID_JSON' },
    };
  }
  if (error?.code === 'LIMIT_UNEXPECTED_FILE') {
    return {
      status: 400,
      body: { error: 'Unexpected upload field or file.', code: 'MULTIPART_INVALID' },
    };
  }
  return {
    status: 500,
    body: { error: 'The service could not complete this request. Please retry shortly.', code: 'INTERNAL_ERROR' },
  };
}
