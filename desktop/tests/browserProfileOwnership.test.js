import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireBrowserProfileOwnership, getBrowserProfileLockTarget, registerBrowserProfileProcess, withBrowserProfileOwnership } from '../browserProfileOwnership.js';
import { closeOwnedBrowserProcess } from '../browserProcessLifecycle.js';
import { createExternalBrowserSession } from '../externalBrowserSession.js';
import { createBrowserRecoveryRegistry } from '../browserRecoveryRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DESKTOP_DIR = path.resolve(__dirname, '..');

function makeTempProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcw-profile-ownership-'));
  return { root, profileDir: path.join(root, 'browser-profiles', 'flipkart_shopsy') };
}

function startLockHolder(profileDir) {
  const moduleUrl = pathToFileURL(path.join(DESKTOP_DIR, 'browserProfileOwnership.js')).href;
  const script = `
    import { acquireBrowserProfileOwnership } from ${JSON.stringify(moduleUrl)};
    const release = await acquireBrowserProfileOwnership(${JSON.stringify(profileDir)});
    process.stdout.write('PROFILE_LOCKED\\n');
    process.stdin.resume();
    process.stdin.once('data', async () => {
      await release();
      process.stdout.write('PROFILE_RELEASED\\n');
      process.exit(0);
    });
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

test('browser profile ownership excludes a second process and lets reset proceed after release', async () => {
  const { root, profileDir } = makeTempProfile();
  const child = startLockHolder(profileDir);
  let stdout = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const childExit = new Promise(resolve => child.once('exit', code => resolve(code)));
  const timeout = setTimeout(() => readyReject(new Error(`Profile lock holder did not start: ${stderr}`)), 10000);

  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
    if (stdout.includes('PROFILE_LOCKED')) {
      clearTimeout(timeout);
      readyResolve();
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.once('error', error => {
    clearTimeout(timeout);
    readyReject(error);
  });

  try {
    await ready;
    const lockDirectory = `${getBrowserProfileLockTarget(profileDir)}.lock`;
    const staleTime = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lockDirectory, staleTime, staleTime);
    let resetStarted = false;
    await assert.rejects(
      withBrowserProfileOwnership(profileDir, async () => { resetStarted = true; }),
      error => error?.code === 'BROWSER_PROFILE_IN_USE'
    );
    assert.equal(resetStarted, false, 'reset must not begin while another process owns the live profile');

    child.stdin.write('release\n');
    assert.equal(await childExit, 0, stderr);
    assert(stdout.includes('PROFILE_RELEASED'));

    let resetCompleted = false;
    await withBrowserProfileOwnership(profileDir, async () => { resetCompleted = true; });
    assert.equal(resetCompleted, true, 'reset may proceed once Chromium ownership has ended');
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill();
      await childExit;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale owner heartbeat cannot release a profile while the recorded Chromium PID is alive', async () => {
  const { root, profileDir } = makeTempProfile();
  const release = await acquireBrowserProfileOwnership(profileDir);
  const target = getBrowserProfileLockTarget(profileDir);

  try {
    const ownerPath = `${target}.owner.json`;
    const metadata = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    metadata.pid = -1; // Simulate a crashed desktop process with an orphaned Chrome child.
    metadata.browserPids = [process.pid];
    fs.writeFileSync(ownerPath, JSON.stringify(metadata), { mode: 0o600 });
    const staleTime = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(`${target}.lock`, staleTime, staleTime);

    await assert.rejects(
      acquireBrowserProfileOwnership(profileDir),
      error => error?.code === 'BROWSER_PROFILE_IN_USE'
    );
  } finally {
    await release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retained external Seller Hub browser holds profile ownership until it disconnects', async () => {
  const { root, profileDir } = makeTempProfile();
  let disconnected;
  const page = {
    browser: () => browser,
    isClosed: () => false,
    url: () => 'https://seller.flipkart.com/'
  };
  const browser = {
    connected: true,
    isConnected() { return this.connected; },
    on(event, callback) { if (event === 'disconnected') disconnected = callback; },
    async pages() { return this.connected ? [page] : []; },
    async close() {
      this.connected = false;
      disconnected?.();
    }
  };
  const runtime = { launch: async () => browser };
  const session = createExternalBrowserSession();

  try {
    await session.acquire(runtime, { headless: false, userDataDir: profileDir }, {
      profileKey: profileDir,
      keepOpen: true
    });
    await assert.rejects(acquireBrowserProfileOwnership(profileDir), error => error?.code === 'BROWSER_PROFILE_IN_USE');

    await session.close({ profileKey: profileDir, reason: 'cookie-reset' });
    const release = await acquireBrowserProfileOwnership(profileDir);
    await release();
  } finally {
    await session.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Puppeteer disconnect does not release the profile while its Chromium child is alive', async () => {
  const { root, profileDir } = makeTempProfile();
  const child = new EventEmitter();
  Object.assign(child, { pid: process.pid, exitCode: null, signalCode: null });
  let disconnected;
  let connected = true;
  const page = {
    browser: () => browser,
    isClosed: () => false,
    url: () => 'https://seller.flipkart.com/'
  };
  const browser = {
    process: () => child,
    isConnected: () => connected,
    on(event, callback) { if (event === 'disconnected') disconnected = callback; },
    async pages() { return connected ? [page] : []; },
    async close() { connected = false; disconnected?.(); }
  };
  const session = createExternalBrowserSession();

  try {
    await session.acquire({ launch: async () => browser }, { headless: false, userDataDir: profileDir }, {
      profileKey: profileDir,
      keepOpen: true
    });
    const metadataPath = `${getBrowserProfileLockTarget(profileDir)}.owner.json`;
    const ownerMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    assert(ownerMetadata.browserPids.includes(process.pid), 'the owner record should include the Chromium process ID');

    connected = false;
    disconnected?.();
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(acquireBrowserProfileOwnership(profileDir), error => error?.code === 'BROWSER_PROFILE_IN_USE');

    child.exitCode = 0;
    child.emit('exit', 0, null);
    await new Promise(resolve => setImmediate(resolve));
    const release = await acquireBrowserProfileOwnership(profileDir);
    await release();
  } finally {
    await session.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('closing an owned Chromium process waits for exit and terminates a child left after CDP disconnect', async () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: process.pid, exitCode: null, signalCode: null });
  child.kill = () => {
    child.signalCode = 'SIGTERM';
    child.emit('exit', null, 'SIGTERM');
    return true;
  };
  let connected = true;
  const browser = {
    process: () => child,
    isConnected: () => connected,
    async close() { connected = false; }
  };

  await closeOwnedBrowserProcess(browser, { exitTimeoutMs: 1, terminateTimeoutMs: 10 });
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(connected, false);
});

test('browser recovery releases profile ownership only after a confirmed close', async () => {
  const registry = createBrowserRecoveryRegistry();
  let releaseCount = 0;
  let disconnected;
  let connected = true;
  const browser = {
    isConnected: () => connected,
    on: (event, callback) => { if (event === 'disconnected') disconnected = callback; },
    async close() {
      connected = false;
      disconnected?.();
    }
  };
  const lease = registry.track(browser, 'shared-profile', {
    releaseProfileOwnership: async () => { releaseCount += 1; }
  });

  await lease.close();
  assert.equal(releaseCount, 1);
  assert.equal(registry.hasProfile('shared-profile'), false);
});
