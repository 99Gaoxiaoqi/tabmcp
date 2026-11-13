/**
 * Install the extension + native host.
 *
 * Writes the native messaging host manifest and the registry key Chrome reads
 * on Windows, so `chrome.runtime.connectNative('com.local.tabmcp')`
 * can find our host process.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ActionError } from '../core/errors.js';

/**
 * The native host name is the one string that must agree in three places: the
 * registry key, the host manifest, and the extension's connectNative call. It is
 * written once in host.config.json and read from there.
 *
 * Three rules, all learned the hard way:
 *
 *  1. Look next to this file, never in the process cwd. A cwd-relative lookup makes
 *     the same checkout install under two different names depending on where you
 *     stood when you ran it, and a stray host.config.json in an unrelated directory
 *     wins over the repository's own.
 *  2. If the name cannot be read, say so. Returning a hardcoded default invents a
 *     plausible value - the outcome is a host registered under a name nothing calls,
 *     which surfaces as "the extension is listed, nothing errors, every call fails".
 *     `scripts/doctor-host.mjs` already refuses to guess about this same fact; making
 *     one component shout and the other invent a value was the actual defect.
 *  3. "Missing" and "found but unusable" are different facts and get different
 *     sentences. A reader told "not found" goes looking for a file that is right
 *     there - the same mismatch this repository keeps finding in other forms.
 *
 * The lookup is a pure function of the module URL so the walk can be tested as
 * strings; `hostName()` is only the binding to this module's own location.
 */
export type CandidateResult = 'missing' | 'unreadable' | 'no-hostName';

export interface CandidateOutcome {
  path: string;
  result: CandidateResult;
}

/** Pure: where to look, given where this module lives. */
export function hostConfigCandidates(moduleUrl: string | URL): string[] {
  // fileURLToPath, not pathname string surgery: a pathname keeps percent-encoding and
  // mangles spaces, CJK and UNC prefixes (`\\server\share`).
  const here = path.dirname(fileURLToPath(moduleUrl));
  return [
    // dist/src/host -> repository root, and one level up in case the layout changes.
    path.join(here, '..', '..', '..', 'host.config.json'),
    path.join(here, '..', '..', 'host.config.json'),
  ];
}

/** Reads the first candidate that yields a name, reporting what happened at every stop. */
export function readHostName(candidates: string[]): { name: string; looked: CandidateOutcome[] } {
  const looked: CandidateOutcome[] = [];
  for (const candidate of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch {
      looked.push({ path: candidate, result: 'missing' });
      continue;
    }
    let parsed: { hostName?: string };
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as { hostName?: string };
    } catch {
      looked.push({ path: candidate, result: 'unreadable' });
      continue;
    }
    if (typeof parsed.hostName === 'string' && parsed.hostName !== '') {
      return { name: parsed.hostName, looked };
    }
    looked.push({ path: candidate, result: 'no-hostName' });
  }

  const unreadable = looked.filter((entry) => entry.result === 'unreadable');
  const empty = looked.filter((entry) => entry.result === 'no-hostName');
  const message = unreadable.length
    ? `host.config.json could not be parsed: ${unreadable.map((entry) => entry.path).join(', ')}`
    : empty.length
      ? `host.config.json has no hostName: ${empty.map((entry) => entry.path).join(', ')}`
      : 'host.config.json was not found next to this package';
  throw new ActionError('E_PRECONDITION_FAILED', message, {
    hint: 'The host name must be one value, not a guess. Restore host.config.json or re-run npm run setup:extension from a complete checkout.',
    data: { looked },
  });
}

/**
 * Resolved when it is needed, not when the module is imported: a prerequisite should
 * fail at the moment of use, so the stack points at the caller instead of at some
 * consumer that merely imported this file.
 */
export function hostName(): string {
  return readHostName(hostConfigCandidates(import.meta.url)).name;
}


export interface InstallOptions {
  /** Absolute path to the extension directory (contains manifest.json). */
  extensionDir: string;
  /** Absolute path to dist/src/host/native.js. */
  hostScript: string;
  /** Chrome extension id, once loaded unpacked. */
  extensionId: string;
  nodePath?: string;
}

export interface InstallResult {
  manifestPath: string;
  registryKey: string;
  extensionId: string;
}

function hostManifestPath(): string {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'tabmcp');
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, `${hostName()}.json`);
}

export function install(options: InstallOptions): InstallResult {
  const node = options.nodePath ?? process.execPath;
  // The manifest records this path verbatim and Chrome only discovers the problem
  // when the user clicks the extension, long after install reported success. Checking
  // here is what makes the failure land where someone is looking.
  if (!fs.existsSync(node) || !fs.statSync(node).isFile()) {
    throw new ActionError(
      options.nodePath ? 'E_BAD_ARGUMENT' : 'E_PRECONDITION_FAILED',
      `native host executable does not exist: ${node}`,
      {
        hint: options.nodePath
          ? 'Pass an existing node executable, or omit nodePath to use the one running this process.'
          : 'The node running the installer is not a file on disk. Reinstall node, or pass nodePath explicitly.',
        data: { nodePath: node, exists: fs.existsSync(node) },
      },
    );
  }
  const manifest = {
    name: hostName(),
    description: 'TabMCP host',
    path: node,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${options.extensionId}/`],
  };
  const manifestPath = hostManifestPath();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // Chrome on Windows resolves native hosts from HKCU, not PATH.
  const registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName()}`;
  execFileSync('reg', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'pipe' });

  return { manifestPath, registryKey, extensionId: options.extensionId };
}

export function uninstall(): void {
  const manifestPath = hostManifestPath();
  fs.rmSync(manifestPath, { force: true });
  try {
    execFileSync('reg', ['delete', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName()}`, '/f'], {
      stdio: 'pipe',
    });
  } catch {
    // Already gone.
  }
}
