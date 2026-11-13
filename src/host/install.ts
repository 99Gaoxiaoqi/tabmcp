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
 * Two rules, both learned the hard way:
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
 */
export function hostName(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dist/src/host -> repository root, and the same walk one level up in case the
    // build layout changes.
    path.join(here, '..', '..', '..', 'host.config.json'),
    path.join(here, '..', '..', 'host.config.json'),
  ];
  const seen: string[] = [];
  for (const candidate of candidates) {
    seen.push(candidate);
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '')) as { hostName?: string };
      if (parsed.hostName) return parsed.hostName;
    } catch {
      // try the next location
    }
  }
  throw new ActionError(
    'E_PRECONDITION_FAILED',
    'host.config.json with a hostName was not found next to this package',
    {
      hint: 'The host name must be one value, not a guess. Restore host.config.json or re-run npm run setup:extension from a complete checkout.',
      data: { looked: seen },
    },
  );
}

export const HOST_NAME = hostName();


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
  return path.join(base, `${HOST_NAME}.json`);
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
    name: HOST_NAME,
    description: 'TabMCP host',
    path: node,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${options.extensionId}/`],
  };
  const manifestPath = hostManifestPath();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // Chrome on Windows resolves native hosts from HKCU, not PATH.
  const registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  execFileSync('reg', ['add', registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'pipe' });

  return { manifestPath, registryKey, extensionId: options.extensionId };
}

export function uninstall(): void {
  const manifestPath = hostManifestPath();
  fs.rmSync(manifestPath, { force: true });
  try {
    execFileSync('reg', ['delete', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, '/f'], {
      stdio: 'pipe',
    });
  } catch {
    // Already gone.
  }
}
