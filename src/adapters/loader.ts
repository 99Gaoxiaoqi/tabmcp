/**
 * Adapter discovery.
 *
 * Two sources, same shape:
 *   - built-ins shipped with this package (`adapters/`)
 *   - user adapters under `%APPDATA%/tabmcp/adapters/<site>/<command>.js`
 *
 * Files starting with `_` are shared helpers, not commands. A broken adapter is
 * reported with its file and problems instead of taking the whole list down.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateDefinition, type AdapterDefinition } from '../sdk/index.js';

export interface LoadedAdapter {
  site: string;
  command: string;
  /** `site command`, the same name an agent sees. */
  toolName: string;
  definition: AdapterDefinition;
  file: string;
  source: 'builtin' | 'user';
}

export interface AdapterProblem {
  file: string;
  problems: string[];
}

export interface AdapterCatalog {
  adapters: LoadedAdapter[];
  problems: AdapterProblem[];
}

export interface LoadOptions {
  builtinDir?: string;
  userDir?: string;
}

export function defaultUserAdapterDir(): string {
  const base = process.env.TABMCP_HOME ?? path.join(os.homedir(), 'AppData', 'Roaming', 'tabmcp');
  return path.join(base, 'adapters');
}

export function defaultBuiltinAdapterDir(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'adapters');
}

function listJsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_'))
    .map((entry) => path.join(dir, entry.name));
}

/**
 * Loads adapters, tolerating individual failures.
 *
 * Discovery is deliberately filesystem-driven rather than manifest-driven: adding
 * a site means dropping in a file, and a syntax error in one adapter must not
 * hide the others.
 */
export async function loadAdapters(options: LoadOptions = {}): Promise<AdapterCatalog> {
  const builtinDir = options.builtinDir ?? defaultBuiltinAdapterDir();
  const userDir = options.userDir ?? defaultUserAdapterDir();
  const adapters: LoadedAdapter[] = [];
  const problems: AdapterProblem[] = [];

  for (const [root, source] of [
    [builtinDir, 'builtin'] as const,
    [userDir, 'user'] as const,
  ]) {
    if (!fs.existsSync(root)) continue;
    for (const siteEntry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!siteEntry.isDirectory()) continue;
      const site = siteEntry.name;
      for (const file of listJsFiles(path.join(root, site))) {
        const command = path.basename(file, '.js');
        try {
          const module = (await import(`${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`)) as {
            default?: unknown;
            adapter?: unknown;
          };
          const exported = module.default ?? module.adapter;
          const checked = validateDefinition(exported);
          if (!checked.ok) {
            problems.push({ file, problems: checked.problems });
            continue;
          }
          adapters.push({
            site,
            command,
            toolName: `${site} ${command}`,
            definition: checked.definition,
            file,
            source,
          });
        } catch (err) {
          problems.push({ file, problems: [err instanceof Error ? err.message : String(err)] });
        }
      }
    }
  }

  adapters.sort((a, b) => a.toolName.localeCompare(b.toolName));
  return { adapters, problems };
}

/** Case-insensitive search across site, command and description. */
export function searchAdapters(catalog: AdapterCatalog, query: string): LoadedAdapter[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return catalog.adapters;
  return catalog.adapters.filter((adapter) => {
    const haystack = `${adapter.site} ${adapter.command} ${adapter.definition.description} ${adapter.definition.domain ?? ''}`.toLowerCase();
    return haystack.includes(needle);
  });
}

export function findAdapter(catalog: AdapterCatalog, site: string, command: string): LoadedAdapter | undefined {
  return catalog.adapters.find(
    (adapter) =>
      adapter.site.toLowerCase() === site.toLowerCase() && adapter.command.toLowerCase() === command.toLowerCase(),
  );
}
