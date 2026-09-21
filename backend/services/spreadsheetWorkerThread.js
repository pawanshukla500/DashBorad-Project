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
  if (Array.isArray(sheet)) fillBlankRows(sheet, options);
  return XLSX.utils.sheet_to_json(sheet, options);
}

// A dense sheet has no entry for a row without cells, and sheet_to_json then
// emits [] where the sparse (non-dense) parse yields a row of `defval`s. Give
// those rows an empty array so the output is identical to the sparse parse.
function fillBlankRows(sheet, options) {
  const keepsBlankRows = options.header === 1 ? options.blankrows !== false : Boolean(options.blankrows);
  if (options.defval === undefined || !keepsBlankRows || sheet['!ref'] == null) return;
  const range = jsonRange(sheet, options);
  for (let r = range.s.r; r <= range.e.r; r++) {
    if (!sheet[r]) sheet[r] = [];
  }
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
  if (!Array.isArray(sheet) || sheet['!ref'] == null) return;
  const rowCount = Math.min(sheet.length, XLSX.utils.decode_range(sheet['!ref']).e.r + 1);
  for (let start = 0; start < rowCount; start += perChunk) {
    const chunk = new Array(Math.min(perChunk, rowCount - start));
    for (let i = 0; i < chunk.length; i++) {
      const row = sheet[start + i];
      if (row) chunk[i] = row.map(cellValue);
      sheet[start + i] = undefined;
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
