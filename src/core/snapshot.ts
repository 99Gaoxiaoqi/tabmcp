/**
 * Snapshot: a compact, bounded view of what an agent can act on.
 *
 * Emits interactive elements (with refs) plus a little structure (headings,
 * landmarks) so the agent can orient itself without reading the whole HTML.
 * Output is bounded by node count and characters; anything cut is reported so
 * the caller knows to narrow its query rather than assume the page is tiny.
 */

import type { ScriptProbe } from './activity.js';
import { REF_ATTRIBUTE } from './refs.js';

export interface SnapshotNode {
  ref?: string;
  role: string;
  name: string;
  value?: string;
  /** Why the node is in the list: interactive targets vs. orientation only. */
  kind: 'action' | 'structure';
  disabled?: boolean;
}

export interface SnapshotResult {
  url: string;
  title: string;
  docId: string;
  nodes: SnapshotNode[];
  total: number;
  truncated: boolean;
}

export interface SnapshotOptions {
  maxNodes?: number;
  includeStructure?: boolean;
  generation: string;
}

/** Runs in the page: collects interactive + structural nodes and tags targets. */
const COLLECT_SCRIPT = `(({ attribute, generation, maxNodes, includeStructure }) => {
  const IMPLICIT_ACTION = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','OPTION','LABEL']);
  const ACTION_ROLES = new Set(['button','link','checkbox','radio','switch','tab','menuitem','option','textbox','searchbox','combobox','slider','spinbutton','treeitem','gridcell']);
  const STRUCTURE_ROLES = new Set(['heading','navigation','main','banner','contentinfo','complementary','region','table','dialog','alert','status','form']);
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','META','LINK','HEAD']);

  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    return true;
  };

  const implicitRole = (el) => {
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    if (tag === 'SUMMARY') return 'button';
    if (tag === 'OPTION') return 'option';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'NAV') return 'navigation';
    if (tag === 'MAIN') return 'main';
    if (tag === 'HEADER') return 'banner';
    if (tag === 'FOOTER') return 'contentinfo';
    if (tag === 'ASIDE') return 'complementary';
    if (tag === 'FORM') return 'form';
    if (tag === 'DIALOG') return 'dialog';
    if (tag === 'TABLE') return 'table';
    if (tag === 'UL' || tag === 'OL') return 'list';
    if (tag === 'LI') return 'listitem';
    return 'generic';
  };

  const roleOf = (el) => clean(el.getAttribute('role')) || implicitRole(el);

  const nameOf = (el) => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const parts = labelled.split(/\\s+/).map((id) => {
        const target = document.getElementById(id);
        return target ? clean(target.textContent) : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const label = el.labels && el.labels[0] ? clean(el.labels[0].textContent) : '';
      if (label) return label;
      const placeholder = clean(el.getAttribute('placeholder'));
      if (placeholder) return placeholder;
      const title = clean(el.getAttribute('title'));
      if (title) return title;
      if (el.type === 'submit' || el.type === 'button') return clean(el.value);
      const alt = clean(el.getAttribute('alt'));
      if (alt) return alt;
      return '';
    }
    const imgAlt = tag === 'IMG' ? clean(el.getAttribute('alt')) : '';
    if (imgAlt) return imgAlt;
    const title = clean(el.getAttribute('title'));
    if (title) return title;
    const text = clean(el.innerText || el.textContent);
    return text.length > 120 ? text.slice(0, 120) : text;
  };

  const valueOf = (el) => {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['password','hidden'].includes(type)) return type === 'password' ? '<hidden>' : undefined;
      if (type === 'checkbox' || type === 'radio') return el.checked ? 'checked' : 'unchecked';
      return clean(el.value) || undefined;
    }
    if (tag === 'TEXTAREA') return clean(el.value) || undefined;
    if (tag === 'SELECT') {
      const selected = Array.from(el.selectedOptions || []).map((o) => clean(o.textContent));
      return selected.length ? selected.join(', ') : undefined;
    }
    const aria = el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || el.getAttribute('aria-valuenow');
    return aria ? clean(aria) : undefined;
  };

  const isAction = (el, role) => {
    if (SKIP.has(el.tagName)) return false;
    if (ACTION_ROLES.has(role)) return true;
    if (IMPLICIT_ACTION.has(el.tagName) && role !== 'generic') return true;
    if (el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) >= 0) return true;
    if (el.isContentEditable) return true;
    return false;
  };

  const isStructure = (el, role) => {
    if (STRUCTURE_ROLES.has(role)) return true;
    if (/^H[1-6]$/.test(el.tagName)) return true;
    return false;
  };

  const nodes = [];
  let total = 0;
  let index = 0;

  const visit = (el) => {
    if (SKIP.has(el.tagName)) return;
    if (el.hasAttribute('aria-hidden') && el.getAttribute('aria-hidden') !== 'false') return;
    const role = roleOf(el);
    const action = isAction(el, role);
    const structure = includeStructure && isStructure(el, role);
    if ((action || structure) && visible(el)) {
      total++;
      if (nodes.length < maxNodes) {
        const node = { role, name: nameOf(el), kind: action ? 'action' : 'structure' };
        const value = valueOf(el);
        if (value !== undefined) node.value = value;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') node.disabled = true;
        if (action) {
          index++;
          const ref = 'e' + generation + '_' + index;
          el.setAttribute(attribute, ref);
          node.ref = ref;
        }
        nodes.push(node);
      }
    }
    const children = el.children || [];
    for (const child of children) visit(child);
    if (el.shadowRoot) {
      const shadowChildren = el.shadowRoot.children || [];
      for (const child of shadowChildren) visit(child);
    }
  };

  const root = document.body || document.documentElement;
  if (root) visit(root);

  return { nodes, total, url: location.href, title: document.title };
})`;

export async function captureSnapshot(
  probe: ScriptProbe,
  docId: string,
  options: SnapshotOptions,
): Promise<SnapshotResult> {
  const script = `(${COLLECT_SCRIPT})(${JSON.stringify({
    attribute: REF_ATTRIBUTE,
    generation: options.generation,
    maxNodes: options.maxNodes ?? 400,
    includeStructure: options.includeStructure ?? true,
  })})`;
  const result = (await probe.evaluate(script)) as {
    nodes: SnapshotNode[];
    total: number;
    url: string;
    title: string;
  };

  return {
    url: result.url,
    title: result.title,
    docId,
    nodes: result.nodes,
    total: result.total,
    truncated: result.total > result.nodes.length,
  };
}

/** Render a snapshot as compact text lines: `ref role "name" [value]`. */
export function renderSnapshot(snapshot: SnapshotResult, maxChars = 8000): string {
  const lines: string[] = [];
  let used = 0;
  for (const node of snapshot.nodes) {
    const ref = node.ref ? `${node.ref} ` : '';
    const value = node.value ? ` = ${JSON.stringify(node.value)}` : '';
    const disabled = node.disabled ? ' (disabled)' : '';
    const line = `${ref}${node.role} ${JSON.stringify(node.name).replace(/^"|"$/g, '"')}${value}${disabled}`;
    if (used + line.length + 1 > maxChars) return `${lines.join('\n')}\n…(truncated at ${lines.length}/${snapshot.nodes.length} nodes)`;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}


