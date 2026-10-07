// Worker-thread side of spreadsheetWorker.js. Parses one workbook with SheetJS
// and posts the requested sheets' rows, in chunks, to the rows port the parent
// drains once this thread has exited. Only this file runs XLSX.read and
// sheet_to_json, so neither the parse nor one huge structured-clone
// deserialization happens on the API's event loop.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const XLSX = createRequire(import.meta.url)('xlsx');

// About 50k values per chunk keeps each deserialization on the parent to a
// few milliseconds.
const CHUNK_CELLS = 50_000;

// Day-first date text such as "05-04-2026" or "26-04-26 10:30", and the
// default date format SheetJS gives a date it read from text; see
// restoreMisreadDates. Declared before run() starts, which uses them.
const DAY_FIRST_DATE = /^(\d{1,2})-(\d{1,2})-(\d{4}|\d{2})(?:[T ]|$)/;
const TEXT_DATE_FORMAT = XLSX.SSF.get_table()[14];

if (parentPort && workerData?.kind === 'spreadsheet-parse') {
  run(workerData).catch((error) => {
    parentPort.postMessage({
      type: 'error',
      name: error?.name,
      message: String(error?.message ?? error),
      code: error?.code,
      stack: error?.stack,
    });
  });
}

async function run(job) {
  const { spec, rowsPort } = job;
  const selection = spec.select
    ? new Promise(resolve => parentPort.once('message', message => resolve(message.names)))
    : null;
  let workbook = readWorkbook(job);

  parentPort.postMessage({ type: 'sheetNames', sheetNames: workbook.SheetNames });
  const wanted = selection
    ? await selection
    : workbook.SheetNames.filter((name, index) => matchesSheetFilter(spec.sheets, name, index));
  const selected = [...new Set(wanted)].filter(name => Object.hasOwn(workbook.Sheets, name));

  // Formats other than XLSX/XLSB ignore the `sheets` read option; drop what
  // was parsed but not selected before extracting rows.
  for (const name of Object.keys(workbook.Sheets)) {
    if (!selected.includes(name)) delete workbook.Sheets[name];
  }
  for (const name of selected) restoreMisreadDates(workbook.Sheets[name]);

  for (const name of selected) {
    const ref = workbook.Sheets[name]['!ref'];
    const perChunk = Math.max(1, Math.floor(CHUNK_CELLS / columnCount(ref)));
    rowsPort.postMessage({ type: 'sheet', name, ref });
    const chunks = spec.values
      ? cellValueChunks(takeSheet(workbook, name), perChunk)
      : rowChunks(sheetRows(takeSheet(workbook, name), spec.json), perChunk);
    for (const rows of chunks) rowsPort.postMessage({ type: 'rows', rows });
  }
  workbook = null;
  parentPort.postMessage({ type: 'done' });
}

// Removes a sheet from the workbook so that the caller holds its only
// reference and its cells can be freed as soon as they are converted.
function takeSheet(workbook, name) {
  const sheet = workbook.Sheets[name];
  delete workbook.Sheets[name];
  return sheet;
}

function readWorkbook(job) {
  const { data, spec } = job;
  // The parent transferred (or copied) the file into this thread; drop the
  // reference once parsed so its memory can be reclaimed while streaming.
  job.data = null;
  const options = { ...spec.read, type: 'buffer', dense: true };
  if (spec.sheets !== undefined) options.sheets = spec.sheets;
  return XLSX.read(Buffer.from(data.buffer, data.byteOffset, data.byteLength), options);
}

// Same rule as XLSX.read's `sheets` option: a sheet index or a sheet name
// (case-insensitive), or an array of them; anything else keeps every sheet.
function matchesSheetFilter(filter, name, index) {
  const matches = item => (typeof item === 'number' && item === index)
    || (typeof item === 'string' && item.toLowerCase() === name.toLowerCase());
  if (Array.isArray(filter)) return filter.some(matches);
  if (typeof filter === 'number' || typeof filter === 'string') return matches(filter);
  return true;
}

function sheetRows(sheet, options) {
  fillBlankRows(sheet, options);
  return XLSX.utils.sheet_to_json(sheet, options);
}

// A dense sheet keeps its rows in `sheet['!data']`, with no entry for a row
// without cells, and sheet_to_json then emits [] where the sparse (non-dense)
// parse yields a row of `defval`s. Give those rows an empty array so the
// output is identical to the sparse parse.
function fillBlankRows(sheet, options) {
  const rows = sheet['!data'];
  const keepsBlankRows = options.header === 1 ? options.blankrows !== false : Boolean(options.blankrows);
  if (options.defval === undefined || !keepsBlankRows || !rows || sheet['!ref'] == null) return;
  const range = jsonRange(sheet, options);
  for (let r = range.s.r; r <= range.e.r; r++) {
    if (!rows[r]) rows[r] = [];
  }
}

// SheetJS reads date text in HTML tables (the ".xls" some portals export) as
// year-month-day even when it is day-first: "05-04-2026" becomes year 5 plus
// 2026 days, 1910-10-17. Such a cell has the default date format and keeps
// the text it was read from in `w`, so when its date falls in the year that
// misreading of that text gives, keep the cell as that text; the upload's date
// normalizer then reads it as it reads the same text elsewhere. XLSX/XLS date
// cells carry their own format (or none), so one shown as "30-04-05"
// (1930-04-05 as yy-mm-dd) is left alone.
function restoreMisreadDates(sheet) {
  const rows = sheet['!data'];
  if (!rows) return;
  for (const row of rows) {
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell || (cell.t !== 'd' && cell.t !== 'n') || cell.z !== TEXT_DATE_FORMAT || typeof cell.w !== 'string') continue;
      // Cheap filter before the regex: day-first text has a '-' at index 1 or 2.
      if (cell.w.charCodeAt(1) !== 45 && cell.w.charCodeAt(2) !== 45) continue;
      const match = DAY_FIRST_DATE.exec(cell.w);
      if (match && dateYears(cell).includes(misreadYear(match))) {
        row[c] = { t: 's', v: cell.w, w: cell.w };
      }
    }
  }
}

// The calendar year of a date cell, read both ways round so a date near New
// Year in a non-UTC zone still matches.
function dateYears(cell) {
  if (cell.v instanceof Date) return [cell.v.getFullYear(), cell.v.getUTCFullYear()];
  if (typeof cell.v === 'number') return [new Date(Math.round((cell.v - 25569) * 86_400_000)).getUTCFullYear()];
  return [];
}

// The year SheetJS gets by reading "dd-mm-yyyy" as year-month-day: year 19dd
// pushed on by yyyy days, 1900-1937 for any real date ("05-04-2026" gives 1910).
function misreadYear([, first, second, third]) {
  return new Date(Date.UTC(Number(first), Number(second) - 1, Number(third))).getUTCFullYear();
}

// The row range sheet_to_json reads for these options.
function jsonRange(sheet, options) {
  const range = options.range ?? sheet['!ref'];
  if (typeof range === 'string') return XLSX.utils.decode_range(range);
  if (typeof range === 'number') {
    const decoded = XLSX.utils.decode_range(sheet['!ref']);
    decoded.s.r = range;
    return decoded;
  }
  return range;
}

// sheet_to_json rows in chunks; each chunk is dropped here once it is handed
// out, so the rows already sent can be freed.
function* rowChunks(rows, perChunk) {
  for (let start = 0; start < rows.length; start += perChunk) {
    const chunk = rows.slice(start, start + perChunk);
    rows.fill(undefined, start, start + perChunk);
    yield chunk;
  }
}

// The dense worksheet's rows (indexed by sheet row, empty where a row has no
// cells) with each cell replaced by its `.v`. A cell without a value (e.g. an
// error code SheetJS does not know) is sent as a copy of the cell object, so
// callers that check `'v' in cell` or fall back to the cell see what they saw
// before. Worksheet rows are released as they are converted.
function* cellValueChunks(sheet, perChunk) {
  const rows = sheet['!data'];
  if (!rows || sheet['!ref'] == null) return;
  const rowCount = Math.min(rows.length, XLSX.utils.decode_range(sheet['!ref']).e.r + 1);
  for (let start = 0; start < rowCount; start += perChunk) {
    const chunk = new Array(Math.min(perChunk, rowCount - start));
    for (let i = 0; i < chunk.length; i++) {
      const row = rows[start + i];
      if (row) chunk[i] = row.map(cellValue);
      rows[start + i] = undefined;
    }
    yield chunk;
  }
}

function cellValue(cell) {
  if (cell === null || typeof cell !== 'object') return cell;
  return cell.v !== undefined && cell.v !== null ? cell.v : { ...cell };
}

function columnCount(ref) {
  if (ref == null) return 1;
  const range = XLSX.utils.decode_range(ref);
  return Math.max(1, range.e.c - range.s.c + 1);
}
