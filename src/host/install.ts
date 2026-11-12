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
import { execFileSync } from 'node:child_process';

/**
 * The native host name is the one string that must agree in three places: the
 * registry key, the host manifest, and the extension's connectNative call. It is
 * written once in host.config.json and read from there.
 */
export function hostName(): string {
  const candidates = [
    path.join(process.cwd(), 'host.config.json'),
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'host.config.json'),
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..', 'host.config.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '')) as { hostName?: string };
      if (parsed.hostName) return parsed.hostName;
    } catch {
      // try the next location
    }
  }
  return 'com.local.tabmcp';
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
