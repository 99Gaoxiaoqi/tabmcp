/**
 * Install the extension + native host.
 *
 * Writes the native messaging host manifest and the registry key Chrome reads
 * on Windows, so `chrome.runtime.connectNative('com.local.browsermcp_core')`
 * can find our host process.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const HOST_NAME = 'com.local.browsermcp_core';

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
  const base = path.join(os.homedir(), 'AppData', 'Local', 'browsermcp-core');
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, `${HOST_NAME}.json`);
}

export function install(options: InstallOptions): InstallResult {
  const node = options.nodePath ?? process.execPath;
  const manifest = {
    name: HOST_NAME,
    description: 'Browser MCP core host',
    path: node,
    type: 'stdio',
    args: [options.hostScript],
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
