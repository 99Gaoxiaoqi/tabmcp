/**
 * Globals exposed inside the REPL.
 *
 * `tab` is the same browser API the fixed tools use, and `sites` is the adapter
 * catalogue, so code written in the REPL can be lifted straight into an adapter.
 */

import { ActionError } from '../core/errors.js';
import type { Tab } from '../api/tab.js';
import type { AdapterCatalog } from '../adapters/loader.js';
import { findAdapter, searchAdapters } from '../adapters/loader.js';
import { checkExpectation, runAdapter } from '../adapters/runner.js';

export interface ReplDeps {
  /** Resolves the tab to operate on; called per use so it follows the active tab. */
  tabFor: () => Promise<Tab>;
  catalog: () => Promise<AdapterCatalog>;
  log?: (message: string) => void;
}

export function createReplGlobals(deps: ReplDeps): Record<string, unknown> {
  const log = deps.log ?? (() => undefined);

  const tab = {
    url: async () => (await deps.tabFor()).page.url(),
    title: async () => (await deps.tabFor()).page.title(),
    goto: async (url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'none'; timeoutMs?: number }) =>
      (await deps.tabFor()).goto(url, options ?? {}),
    observe: async (options?: { maxNodes?: number; maxChars?: number; includeStructure?: boolean }) =>
      (await deps.tabFor()).observe(options ?? {}),
    act: async (options: {
      ref: string;
      action: 'click' | 'fill' | 'press' | 'select' | 'hover' | 'scroll';
      value?: string;
      revision?: number;
      timeoutMs?: number;
    }) => (await deps.tabFor()).act(options),
    read: async (options?: { target?: string; format?: 'text' | 'html'; maxChars?: number }) =>
      (await deps.tabFor()).read(options ?? {}),
    screenshot: async (options?: { fullPage?: boolean; format?: 'png' | 'jpeg' }) =>
      (await deps.tabFor()).screenshot(options ?? {}),
    find: async (target: { role?: string; name?: string; text?: string; css?: string; limit?: number }) =>
      (await deps.tabFor()).page.find(target),
    expect: async (what: { selector?: string; text?: string; url?: string }, options?: { timeoutMs?: number }) =>
      (await deps.tabFor()).page.expect(what, options ?? {}),
    cookie: async (name: string, options?: { domain?: string }) => (await deps.tabFor()).page.cookie(name, options ?? {}),
    frames: async () => (await deps.tabFor()).page.frames(),
    reload: async () => (await deps.tabFor()).page.reload(),
    back: async () => (await deps.tabFor()).page.back(),
    forward: async () => (await deps.tabFor()).page.forward(),
    cookies: async (domain: string) => (await deps.tabFor()).page.cookies(domain),
    download: async (options: { selector: string; timeoutMs?: number }) => (await deps.tabFor()).page.download(options),
    contentState: async () => (await deps.tabFor()).page.contentState(),
    networkRead: async (options?: { pattern?: string; limit?: number; afterSequence?: number; includeStatic?: boolean }) =>
      (await deps.tabFor()).page.networkRead(options ?? {}),
    evaluateInFrame: async (target: { index?: number; frameId?: string }, script: string) =>
      (await deps.tabFor()).page.evaluateInFrame(target, script),
    fetchJson: async (url: string, options?: { method?: string; headers?: Record<string, string>; body?: unknown }) =>
      (await deps.tabFor()).page.fetchJson(url, options ?? {}),
  };

  const sites = {
    list: async () => {
      const catalog = await deps.catalog();
      return catalog.adapters.map((adapter) => ({
        site: adapter.site,
        command: adapter.command,
        tool: adapter.toolName,
        access: adapter.definition.access,
        description: adapter.definition.description,
        args: adapter.definition.args ?? [],
      }));
    },
    search: async (query: string) => {
      const catalog = await deps.catalog();
      return searchAdapters(catalog, query).map((adapter) => adapter.toolName);
    },
    run: async (site: string, command: string, args: Record<string, unknown> = {}) => {
      const catalog = await deps.catalog();
      const adapter = findAdapter(catalog, site, command);
      if (!adapter) {
      throw new ActionError('E_TARGET_NOT_FOUND', `no adapter "${site} ${command}"`, {
        hint: 'Run sites_search to list installed adapters.',
      });
    }
      const tabInstance = await deps.tabFor();
      const result = await runAdapter({ adapter, tab: tabInstance.page, args, log });
      const expectation = checkExpectation(adapter.definition.expect, result.result);
      return { ...result, expectation };
    },
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  return { tab, sites, sleep, log };
}


