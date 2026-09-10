import { describe, expect, it } from 'vitest';
import {
  ALLOWED_SPREADSHEET_EXTENSIONS,
  sanitizeUploadFileName,
  spreadsheetFileFilter,
} from '../utils/uploadSecurity.js';

describe('upload security utilities', () => {
  it('whitelists only tabular spreadsheet extensions', () => {
    expect(ALLOWED_SPREADSHEET_EXTENSIONS.has('.csv')).toBe(true);
    expect(ALLOWED_SPREADSHEET_EXTENSIONS.has('.tsv')).toBe(true);
    expect(ALLOWED_SPREADSHEET_EXTENSIONS.has('.txt')).toBe(true);
    expect(ALLOWED_SPREADSHEET_EXTENSIONS.has('.xlsx')).toBe(true);
    expect(ALLOWED_SPREADSHEET_EXTENSIONS.has('.xls')).toBe(true);
    expect(ALLOWED_SPREADSHEET_EXTENSIONS.has('.exe')).toBe(false);
    expect(ALLOWED_SPREADSHEET_EXTENSIONS.has('.js')).toBe(false);
    expect(ALLOWED_SPREADSHEET_EXTENSIONS.has('.php')).toBe(false);
  });

  it('sanitizes malicious filenames against path traversal', () => {
    expect(sanitizeUploadFileName('../../../etc/passwd')).toBe('passwd');
    expect(sanitizeUploadFileName('..\\..\\boot.ini')).toBe('boot.ini');
    expect(sanitizeUploadFileName('normal_file.csv')).toBe('normal_file.csv');
  });

  it('accepts legitimate spreadsheet files in multer fileFilter', () => {
    let accepted = null;
    let err = null;
    spreadsheetFileFilter({}, { originalname: 'sales_report_2026.xlsx' }, (error, ok) => {
      err = error;
      accepted = ok;
    });
    expect(err).toBeNull();
    expect(accepted).toBe(true);
  });

  it('rejects disallowed extensions with HTTP 400 and public message', () => {
    let accepted = null;
    let err = null;
    spreadsheetFileFilter({}, { originalname: 'payload.sh' }, (error, ok) => {
      err = error;
      accepted = ok;
    });
    expect(accepted).toBe(false);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(400);
    expect(err.isPublic).toBe(true);
    expect(err.code).toBe('INVALID_FILE_TYPE');
    expect(err.message).toContain('Unsupported file type ".sh"');
  });
});
