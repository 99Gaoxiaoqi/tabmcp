#!/usr/bin/env node
/**
 * Read-only diagnosis of the installed native-messaging host.
 *
 * Three places must agree for `chrome.runtime.connectNative` to reach the host, and
 * they live in three different places:
 *
 *   1. host.config.json                     the name the repository builds for
 *   2. %LOCALAPPDATA%\tabmcp\<name>.json     the manifest Chrome is pointed at
 *   3. HKCU\...\NativeMessagingHosts\<name>  the registry value Chrome actually reads
 *
 * Plus a fourth fact nothing in the repository can see: whether the executable that
 * the manifest names still exists. That one matters after moving the checkout, and
 * it is why `verify` passing says nothing about a working install.
 *
 * Nothing here writes. Not part of `verify`: a machine without Chrome installed is a
 * legitimate state, and a gate that fails on it would be turned off within a week.
 *
 * Exit codes:
 *   0  the three places agree and the executable exists
 *   1  they disagree, or the executable is gone (the report names which)
 *   2  the check cannot read what it needs (no config, or no manifest to inspect)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(REPO_ROOT);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

const fail = (lines) => {
  for (const line of lines) console.error(line);
  process.exit(2);
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail([`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`]);
  }
};

const config = readJson('host.config.json');
const expectedName = config.hostName;
if (!expectedName || typeof expectedName !== 'string') {
  fail(['host.config.json must contain a "hostName" string']);
}

const manifestPath =
  option('--manifest') ?? path.join(os.homedir(), 'AppData', 'Local', 'tabmcp', `${expectedName}.json`);
const registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${expectedName}`;

const rows = [];
const problems = [];

const record = (label, value, state) => {
  rows.push({ label, value, state });
  if (state === 'mismatch' || state === 'missing') problems.push(`${label}: ${value}`);
};

// 1. what the repository builds for
record('host.config.json hostName', expectedName, 'ok');

// 2. the manifest Chrome would read
if (!fs.existsSync(manifestPath)) {
  record('installed manifest', `${manifestPath} (not found)`, 'missing');
} else {
  const manifest = readJson(manifestPath);
  record('installed manifest', manifestPath, 'ok');
  record(
    'manifest name',
    `${manifest.name ?? '(absent)'}${manifest.name === expectedName ? '' : ` != ${expectedName}`}`,
    manifest.name === expectedName ? 'ok' : 'mismatch',
  );
  const executable = typeof manifest.path === 'string' ? manifest.path : '';
  record('manifest path', executable || '(absent)', executable ? 'ok' : 'mismatch');
  if (!executable) {
    // nothing more to say about the executable
  } else if (!fs.existsSync(executable)) {
    record('executable exists', `${executable} (not found)`, 'missing');
  } else {
    record('executable exists', `${executable} (${fs.statSync(executable).size} B)`, 'ok');
  }
}

// 3. the registry value Chrome actually reads
if (flag('--skip-registry')) {
  record('registry', 'skipped (--skip-registry)', 'ok');
} else {
  let output = '';
  try {
    output = execFileSync('reg', ['query', registryKey, '/ve'], { encoding: 'utf8', stdio: 'pipe' });
  } catch {
    record('registry', `${registryKey} (key not found)`, 'missing');
  }
  if (output) {
    // `reg query /ve` prints:  "    (Default)    REG_SZ    <path>"
    const match = /\(Default\)\s+REG_SZ\s+(.+)/i.exec(output) ?? /REG_SZ\s+(.+)/i.exec(output);
    const value = match?.[1]?.trim() ?? '(unreadable)';
    record('registry default', value, 'ok');
    const normalise = (p) => path.normalize(p).toLowerCase();
    record(
      'registry matches manifest path',
      value === '(unreadable)' ? value : `${value === manifestPath ? 'same' : 'differs'}`,
      value === '(unreadable)' ? 'unreadable' : value.toLowerCase() === manifestPath.toLowerCase() || normalise(value) === normalise(manifestPath) ? 'ok' : 'mismatch',
    );
  }
}

const width = Math.max(...rows.map((row) => row.label.length));
for (const row of rows) {
  const mark = row.state === 'ok' ? 'ok  ' : row.state === 'mismatch' ? 'DIFF' : 'MISS';
  console.log(`  ${mark} ${row.label.padEnd(width)}  ${row.value}`);
}

if (problems.length) {
  console.error('');
  console.error('native messaging host is not usable as installed:');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('run `npm run setup:extension` (after `npm run build:launcher`) to repair it');
  process.exit(1);
}
console.log('');
console.log(`native messaging host "${expectedName}" is installed and points at an existing executable`);
