/**
 * Draft adapters.
 *
 * Automation can produce a candidate adapter, but a candidate must not appear in
 * tool lists until someone proved it works. Drafts live in their own directory
 * as JSON, carry an expectation, and only become real adapters on activation.
 */

import { ActionError } from '../core/errors.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Access, AdapterExpectation, ArgSpec } from '../sdk/index.js';
import { defaultUserAdapterDir } from './loader.js';

export interface DraftRecord {
  id: string;
  site: string;
  command: string;
  description: string;
  access: Access;
  domain?: string;
  args?: ArgSpec[];
  /** A whole ES module body exporting the adapter as default. */
  source: string;
  expect?: AdapterExpectation;
  createdAt: string;
  /** Set once a verification run passed. */
  verifiedAt?: string;
}

export function defaultDraftDir(): string {
  const base = process.env.TABMCP_HOME ?? path.join(os.homedir(), 'AppData', 'Roaming', 'tabmcp');
  return path.join(base, 'adapter-drafts');
}

export class DraftStore {
  constructor(
    private readonly dir = defaultDraftDir(),
    private readonly adapterDir = defaultUserAdapterDir(),
  ) {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  list(): DraftRecord[] {
    return fs
      .readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as DraftRecord;
        } catch {
          return null;
        }
      })
      .filter((record): record is DraftRecord => record !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  create(input: Omit<DraftRecord, 'id' | 'createdAt'> & { id?: string }): DraftRecord {
    const record: DraftRecord = {
      ...input,
      id: input.id ?? randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(this.dir, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  get(id: string): DraftRecord | undefined {
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as DraftRecord;
  }

  markVerified(id: string): DraftRecord {
    const record = this.get(id);
    if (!record) throw new ActionError('E_TARGET_NOT_FOUND', `draft ${id} not found`);
    record.verifiedAt = new Date().toISOString();
    fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  /**
   * Promotes a verified draft into the user adapter directory.
   *
   * Activation is refused before verification on purpose: an unverified adapter
   * in the tool list is indistinguishable from a broken site.
   */
  activate(id: string): { file: string } {
    const record = this.get(id);
    if (!record) throw new ActionError('E_TARGET_NOT_FOUND', `draft ${id} not found`);
    if (!record.verifiedAt) {
      throw new ActionError('E_PRECONDITION_FAILED', `draft ${id} has not been verified; run it against its expectation first`, {
        hint: 'Run it against its expectation, then activate.',
      });
    }
    const dir = path.join(this.adapterDir, record.site);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${record.command}.js`);
    fs.writeFileSync(file, record.source, 'utf8');
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    return { file };
  }

  remove(id: string): void {
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
  }
}
