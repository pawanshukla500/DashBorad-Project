// Spreadsheet parsing off the event loop.
//
// SheetJS's XLSX.read and sheet_to_json are synchronous: on a 50-150 MB upload
// they held the API's only thread for the whole parse, stalling every other
// request (dashboards, health checks, the upload's own progress polls).
// parseSpreadsheet runs them in a worker thread (spreadsheetWorkerThread.js)
// and resolves with just the rows the caller needs.
//
// Each parse gets its own worker, torn down afterwards so all of its memory is
// returned. At most SPREADSHEET_WORKERS parses (1 by default, 2 at most) are
// in progress at once, from reading the file until the last row has arrived,
// to stay inside the container's 1 GB; further parses wait their turn. A
// parse that runs out of memory now fails that upload instead of crashing the
// API process.
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./spreadsheetWorkerThread.js', import.meta.url);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * @typedef {object} SpreadsheetParseOptions
 * @property {object} [read] XLSX.read options (cellDates, raw, ...). The worker
 *   always adds `type: 'buffer'` and `dense: true`.
 * @property {number|string|Array<number|string>} [sheets] XLSX.read `sheets`
 *   filter: parse only these sheets (index, or name compared case-insensitively).
 * @property {(sheetNames: string[]) => string[]} [select] Picks the sheets to
 *   return from all of the workbook's sheet names; runs on the calling thread.
 *   Defaults to every sheet matched by `sheets`.
 * @property {object} [json] sheet_to_json options for each returned sheet.
 * @property {boolean} [values] Return each sheet as its dense rows with every
 *   cell replaced by its value (`cell.v`) and the sheet's `'!ref'`, instead of
 *   sheet_to_json output.
 * @property {boolean} [transfer] Move the buffer's memory to the worker instead
 *   of copying it. The caller's buffer is left empty (detached) once the parse
 *   starts, so only pass this when the caller has no further use for it.
 *   Either way nothing is taken while the parse waits for a worker slot.
 */

/**
 * A parser with its own worker limit. The app shares one through
 * parseSpreadsheet; tests create their own.
 */
export function createSpreadsheetParser({
  maxWorkers = 1,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  resourceLimits,
} = {}) {
  let running = 0;
  const waiting = [];

  const acquire = () => {
    if (running < maxWorkers) {
      running++;
      return Promise.resolve();
    }
    return new Promise(resolve => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };

  async function parse(buffer, options = {}) {
    const spec = workerSpec(options);
    const bytes = byteView(buffer);
    await acquire();
    return runWorker(bytes, spec, options, { timeoutMs, resourceLimits, release });
  }

  return {
    parse,
    get running() { return running; },
    get queued() { return waiting.length; },
  };
}

const defaultParser = createSpreadsheetParser({
  maxWorkers: Math.min(2, Math.max(1, Number.parseInt(process.env.SPREADSHEET_WORKERS, 10) || 1)),
});

/**
 * Parses a spreadsheet on a worker thread.
 *
 * Resolves with `{ SheetNames, Sheets }`: every sheet name in the workbook,
 * and the rows of each returned sheet - the same rows sheet_to_json gives for
 * a non-dense XLSX.read with the same options. Row objects do not carry
 * sheet_to_json's hidden `__rowNum__` property.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer
 * @param {SpreadsheetParseOptions} [options]
 */
export function parseSpreadsheet(buffer, options) {
  return defaultParser.parse(buffer, options);
}

function workerSpec({ read = {}, sheets, select, json, values = false }) {
  if (select !== undefined && typeof select !== 'function') {
    throw new TypeError('parseSpreadsheet: select must be a function');
  }
  if (values && json !== undefined) {
    throw new TypeError('parseSpreadsheet: pass either json or values, not both');
  }
  return {
    read,
    sheets,
    select: select !== undefined,
    json: values ? undefined : (json ?? {}),
    values: Boolean(values),
  };
}

function byteView(buffer) {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw new TypeError('parseSpreadsheet expects a Buffer, Uint8Array or ArrayBuffer');
}

// Bytes the worker can own: the caller's memory itself when `transfer` is set
// and the buffer spans its whole ArrayBuffer, otherwise an exact-size copy.
function takeBytes(bytes, transfer) {
  const ownsArrayBuffer = bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength;
  if (transfer && ownsArrayBuffer) {
    try {
      return new Uint8Array(structuredClone(bytes.buffer, { transfer: [bytes.buffer] }));
    } catch {
      // Not transferable (e.g. Node's shared Buffer pool): copy instead.
    }
  }
  return bytes.slice();
}

function runWorker(bytes, spec, { select, transfer }, { timeoutMs, resourceLimits, release }) {
  return new Promise((resolve, reject) => {
    // The worker posts the rows to their own port and exits; they are read
    // here only after that, so the worker's heap is gone before the rows
    // build up on this thread.
    const { port1: rowsPort, port2 } = new MessageChannel();
    let worker;
    try {
      // Taken only now that this parse has its slot, so a queued parse never
      // holds a second copy of its file.
      const data = takeBytes(bytes, transfer === true);
      worker = new Worker(WORKER_URL, {
        workerData: { kind: 'spreadsheet-parse', data, spec, rowsPort: port2 },
        transferList: [data.buffer, port2],
        resourceLimits,
      });
    } catch (error) {
      rowsPort.close();
      release();
      reject(error);
      return;
    }

    const book = { SheetNames: [], Sheets: Object.create(null) };
    let parsed = false;
    let settled = false;
    let exited = false;
    let released = false;
    let timer = null;
    // The slot is freed only once the worker is gone and every row has been
    // read, so the next parse never overlaps with this one.
    const releaseSlot = () => {
      if (released || !exited || !settled) return;
      released = true;
      release();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rowsPort.close();
      reject(error);
      void worker.terminate();
      releaseSlot();
    };
    timer = setTimeout(() => {
      fail(new Error(`Reading the spreadsheet took longer than ${timeoutMs / 1000}s and was stopped.`));
    }, timeoutMs);

    // One chunk per event-loop turn: receiveMessageOnPort deserializes a
    // single message, where a 'message' listener would take every queued
    // chunk in one go and block other requests for all of them.
    let rows = null;
    const drain = () => {
      if (settled) return;
      const received = receiveMessageOnPort(rowsPort);
      if (!received) {
        settled = true;
        rowsPort.close();
        resolve(book);
        releaseSlot();
        return;
      }
      const { message } = received;
      if (message.type === 'sheet') {
        rows = [];
        if (spec.values && message.ref !== undefined) rows['!ref'] = message.ref;
        book.Sheets[message.name] = rows;
      } else {
        appendRows(rows, message.rows);
      }
      setImmediate(drain);
    };

    worker.on('message', (message) => {
      if (settled) return;
      if (message.type === 'sheetNames') {
        book.SheetNames = message.sheetNames;
        if (!select) return;
        let names;
        try {
          names = select([...message.sheetNames]);
          if (!Array.isArray(names)) throw new TypeError('parseSpreadsheet: select must return an array of sheet names');
        } catch (error) {
          fail(error);
          return;
        }
        worker.postMessage({ type: 'select', names: names.filter(name => typeof name === 'string') });
      } else if (message.type === 'done') {
        parsed = true;
        void worker.terminate();
      } else if (message.type === 'error') {
        fail(workerError(message));
      }
    });
    worker.on('error', (error) => {
      fail(error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? outOfMemoryError(error) : error);
    });
    worker.on('exit', (code) => {
      exited = true;
      if (!parsed) {
        fail(new Error(`The spreadsheet reader stopped unexpectedly (exit code ${code}).`));
      } else {
        clearTimeout(timer);
        drain();
      }
      releaseSlot();
    });
  });
}

// Appends a streamed chunk, keeping empty slots (rows without cells) empty.
function appendRows(target, chunk) {
  for (let i = 0; i < chunk.length; i++) {
    if (i in chunk) target.push(chunk[i]);
    else target.length++;
  }
}

function workerError({ name, message, code, stack }) {
  const error = new Error(message);
  if (name && name !== 'Error') error.name = name;
  if (code !== undefined) error.code = code;
  // Where SheetJS failed is more useful than this message handler's stack.
  if (stack) error.stack = stack;
  return error;
}

function outOfMemoryError(cause) {
  const error = new Error('The spreadsheet is too large to read with the memory available; upload it in smaller parts.');
  error.status = 413;
  error.code = cause.code;
  error.cause = cause;
  return error;
}
