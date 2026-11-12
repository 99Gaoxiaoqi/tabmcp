/**
 * Opaque element references.
 *
 * A ref is `e<generation>_<n>`: the generation identifies one snapshot (and the
 * document it came from), the number identifies the element within it. Marking
 * the element with an attribute keeps resolution cheap and makes staleness
 * detectable instead of silently acting on whatever is now in that position.
 */

export const REF_ATTRIBUTE = 'data-tabmcp-ref';

const GENERATION_HEX = 10;

export function newGeneration(): string {
  const bytes = new Uint8Array(GENERATION_HEX / 2);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function makeRef(generation: string, index: number): string {
  return `e${generation}_${index}`;
}

export interface RefParts {
  generation: string;
  index: number;
}

const REF_PATTERN = /^e([0-9a-f]{6,32})_(\d{1,6})$/;

export function parseRef(ref: string): RefParts | null {
  const match = REF_PATTERN.exec(ref);
  if (!match) return null;
  return { generation: match[1]!, index: Number(match[2]) };
}

/** A snapshot's identity: which generation of refs it produced. */
export interface SnapshotState {
  generation: string;
  revision: number;
  url: string;
  docId: string;
}

export class RefRegistry {
  private state: SnapshotState | null = null;
  private counter = 0;

  startSnapshot(docId: string, url: string): SnapshotState {
    const generation = newGeneration();
    this.counter = 0;
    const revision = (this.state?.revision ?? 0) + 1;
    this.state = { generation, revision, url, docId };
    return this.state;
  }

  nextRef(): string {
    if (!this.state) throw new ActionError('E_REF_INVALID', 'snapshot not started', {
      hint: 'Call observe() first.',
    });
    return makeRef(this.state.generation, ++this.counter);
  }

  get current(): SnapshotState | null {
    return this.state;
  }

  /** Validates that a ref belongs to the current snapshot and document. */
  assertCurrent(ref: string, docId: string | null): { ok: true } | { ok: false; reason: 'invalid' | 'stale' } {
    const parts = parseRef(ref);
    if (!parts) return { ok: false, reason: 'invalid' };
    if (!this.state) return { ok: false, reason: 'stale' };
    if (parts.generation !== this.state.generation) return { ok: false, reason: 'stale' };
    // 'unknown' means the activity observer could not name the document at one end of
    // the comparison. Treating that as a mismatch made every ref stale after a page
    // where the observer had not installed yet, so it is a wildcard instead.
    const known = (value: string | null): boolean => Boolean(value) && value !== 'unknown';
    if (known(docId) && known(this.state.docId) && this.state.docId !== docId) {
      return { ok: false, reason: 'stale' };
    }
    return { ok: true };
  }
}import { ActionError } from './errors.js';

