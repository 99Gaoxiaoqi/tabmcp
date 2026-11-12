#!/usr/bin/env node
/**
 * Register the native messaging host for the unpacked extension.
 *
 * The host name is read from host.config.json (generated into extension/host-config.js
 * by generate-host-config.mjs), so a rename touches one file. The extension key in
 * manifest.json is never touched: it fixes the extension id, and that id is written
 * into the host manifest's allowed_origins.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'extension', 'manifest.json');
const hostScript = path.join(root, 'dist', 'src', 'host', 'native.js');

const manifestText = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
const manifest = JSON.parse(manifestText);
if (!manifest.key) {
  console.error('extension/manifest.json has no "key"; the extension id would change on every install');
  process.exit(2);
}

// Chrome extension id = first 16 bytes of sha256(DER public key), hex digits mapped 0-f -> a-p.
function extensionIdFromKey(base64Key) {
  const der = Buffer.from(base64Key, 'base64');
  const digest = crypto.createHash('sha256').update(der).digest().subarray(0, 16);
  return [...digest.toString('hex')].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join('');
}

const extensionId = extensionIdFromKey(manifest.key);
if (!fs.existsSync(hostScript)) {
  console.error(`missing ${hostScript}; run npm run build first`);
  process.exit(2);
}

const { install } = await import('../dist/src/host/install.js');
const result = install({
  extensionDir: path.join(root, 'extension'),
  hostScript,
  extensionId,
  // Chrome's native messaging manifest takes an executable path and no extra args,
  // so the launcher is the entry point; it resolves native.js relative to itself.
  nodePath: path.join(root, 'native-host.exe'),
});

console.log(`extension id      ${extensionId}`);
console.log(`host manifest     ${result.manifestPath}`);
console.log(`registry key      ${result.registryKey}`);
