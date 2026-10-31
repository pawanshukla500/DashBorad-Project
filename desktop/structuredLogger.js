import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

const SECRET_KEY = /(cookie|token|password|secret|authorization|credential|api[_-]?key)/i;
const TEXT_SECRET = /\b(authorization|set-cookie|cookie|id[_-]?token|access[_-]?token|refresh[_-]?token|password|secret|api[_-]?key)\s*[:=]\s*(?:bearer\s+)?([^\s,;]+)/gi;
const JWT = /\beyJ[a-zA-Z0-9_-]{12,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g;
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export function redactDiagnosticText(value) {
  return String(value ?? '')
    .replace(TEXT_SECRET, '$1=[REDACTED]')
    .replace(JWT, '[REDACTED_TOKEN]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(postgres(?:ql)?|mysql|redis):\/\/[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1://[REDACTED]@')
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/gi, '$1?[REDACTED]');
}

export function redactDiagnosticValue(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (value instanceof Error) {
    return {
      name: redactDiagnosticText(value.name),
      message: redactDiagnosticText(value.message),
      code: redactDiagnosticText(value.code || ''),
      stack: redactDiagnosticText(String(value.stack || '').split('\n').slice(0, 10).join('\n'))
    };
  }
  if (Buffer.isBuffer(value)) return '[BINARY ' + value.length + ' bytes]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactDiagnosticValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100)
      .map(([childKey, child]) => [childKey, redactDiagnosticValue(child, childKey)]));
  }
  if (typeof value === 'string') return redactDiagnosticText(value).slice(0, 12000);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  return redactDiagnosticText(String(value)).slice(0, 12000);
}

export function createStructuredLogger(directory, { maxBytes = 5 * 1024 * 1024, maxFiles = 4, now = () => new Date() } = {}) {
  const logDirectory = path.resolve(directory);
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(logDirectory, 0o700); } catch {}
  }

  function rotate(file) {
    for (let index = maxFiles - 1; index >= 0; index--) {
      const source = index === 0 ? file : file + '.' + index;
      const destination = file + '.' + (index + 1);
      if (!fs.existsSync(source)) continue;
      try { fs.rmSync(destination, { force: true }); } catch {}
      try { fs.renameSync(source, destination); } catch {}
    }
  }

  function pruneOldLogs() {
    try {
      const files = fs.readdirSync(logDirectory)
        .filter(name => /^desktop-\d{4}-\d{2}-\d{2}\.jsonl(?:\.\d+)?$/.test(name))
        .map(name => ({ name, mtime: fs.statSync(path.join(logDirectory, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
      for (const item of files.slice(maxFiles + 1)) fs.rmSync(path.join(logDirectory, item.name), { force: true });
    } catch {}
  }

  function write(level, event, message, context = {}) {
    const normalizedLevel = LEVELS.has(level) ? level : 'info';
    const timestamp = now().toISOString();
    const file = path.join(logDirectory, 'desktop-' + timestamp.slice(0, 10) + '.jsonl');
    const record = {
      timestamp,
      level: normalizedLevel,
      event: redactDiagnosticText(event || 'desktop.event').slice(0, 120),
      message: redactDiagnosticValue(message),
      context: redactDiagnosticValue(context)
    };
    let serialized;
    try { serialized = JSON.stringify(record).slice(0, 64000) + '\n'; }
    catch { serialized = JSON.stringify({ timestamp, level: 'error', event: 'logger.serialization_failed' }) + '\n'; }
    try {
      const currentSize = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (currentSize + Buffer.byteLength(serialized) > maxBytes) rotate(file);
      fs.appendFileSync(file, serialized, { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') {
        try { fs.chmodSync(file, 0o600); } catch {}
      }
      pruneOldLogs();
    } catch {}
  }

  function installConsoleBridge(target = console) {
    for (const level of ['debug', 'info', 'log', 'warn', 'error']) {
      const original = target[level]?.bind(target);
      if (!original) continue;
      target[level] = (...args) => {
        original(...args);
        const severity = level === 'log' ? 'info' : level;
        write(severity, 'console.' + level, redactDiagnosticText(format(...args)));
      };
    }
  }

  return {
    directory: logDirectory,
    write,
    debug: (event, message, context) => write('debug', event, message, context),
    info: (event, message, context) => write('info', event, message, context),
    warn: (event, message, context) => write('warn', event, message, context),
    error: (event, message, context) => write('error', event, message, context),
    installConsoleBridge
  };
}
