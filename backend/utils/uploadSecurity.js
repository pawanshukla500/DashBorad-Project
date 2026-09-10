import path from 'path';

export const ALLOWED_SPREADSHEET_EXTENSIONS = new Set([
  '.csv',
  '.tsv',
  '.txt',
  '.xlsx',
  '.xls',
]);

export function sanitizeUploadFileName(filename = '') {
  return path.posix.basename(String(filename).replace(/\0/g, '').replace(/\\/g, '/'));
}

export function spreadsheetFileFilter(_req, file, cb) {
  const ext = path.extname(file?.originalname || '').toLowerCase();
  if (!ALLOWED_SPREADSHEET_EXTENSIONS.has(ext)) {
    const error = new Error(
      `Unsupported file type "${ext || 'unknown'}". Only spreadsheet files (${Array.from(ALLOWED_SPREADSHEET_EXTENSIONS).join(', ')}) are permitted.`
    );
    error.status = 400;
    error.isPublic = true;
    error.code = 'INVALID_FILE_TYPE';
    return cb(error, false);
  }
  cb(null, true);
}
