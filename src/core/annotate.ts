/**
 * Screenshot annotation.
 *
 * A vision model cannot reliably map "the third button from the top-left" to a
 * DOM element. Drawing a numbered box on every interactive element turns the
 * screenshot into something it can point at, and the numbers are the same refs
 * the text tools use.
 */

export const ANNOTATE_CSS_ID = '__tabmcp_annotations';

/** Injected before the capture; returns how many elements were marked. */
export const ANNOTATE_SCRIPT = `(() => {
  const HOST = '__tabmcp_annotations';
  const existing = document.getElementById(HOST);
  if (existing) existing.remove();

  const layer = document.createElement('div');
  layer.id = HOST;
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';

  const targets = Array.from(document.querySelectorAll('[data-tabmcp-ref]'));
  let n = 0;
  for (const el of targets) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
    n++;
    const box = document.createElement('div');
    box.style.cssText = [
      'position:fixed',
      'left:' + rect.left + 'px',
      'top:' + rect.top + 'px',
      'width:' + rect.width + 'px',
      'height:' + rect.height + 'px',
      'border:2px solid #ff2d55',
      'border-radius:3px',
      'box-sizing:border-box',
    ].join(';');
    const label = document.createElement('span');
    const ref = el.getAttribute('data-tabmcp-ref') || '';
    const short = ref.split('_')[1] || String(n);
    label.textContent = short;
    label.style.cssText = [
      'position:absolute',
      'top:-16px',
      'left:-2px',
      'background:#ff2d55',
      'color:#fff',
      'font:11px/14px monospace',
      'padding:1px 4px',
      'border-radius:2px',
      'white-space:nowrap',
    ].join(';');
    box.appendChild(label);
    layer.appendChild(box);
  }
  document.documentElement.appendChild(layer);
  return n;
})()`;

export const REMOVE_ANNOTATION_SCRIPT = `(() => {
  const node = document.getElementById('${ANNOTATE_CSS_ID}');
  if (node) node.remove();
  return true;
})()`;
