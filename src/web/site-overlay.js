// Inside the page the team is building: draws each agent where its last edit landed.
// Told by the build room through postMessage; sends nothing but its height and the file it needs.
(() => {
  if (window.top === window) return;
  const layer = document.createElement('div');
  layer.setAttribute('data-ox-overlay', '');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:600 11px/1.2 -apple-system,system-ui,sans-serif';
  const style = document.createElement('style');
  style.textContent = `
    [data-ox-overlay] .box{position:fixed;border:1.5px solid var(--c);border-radius:3px;background:color-mix(in srgb,var(--c) 8%,transparent);transition:all .45s cubic-bezier(.2,.8,.2,1)}
    [data-ox-overlay] .box i{position:absolute;width:6px;height:6px;background:#fff;border:1px solid var(--c);border-radius:50%}
    [data-ox-overlay] .cur{position:fixed;left:0;top:0;transition:transform .45s cubic-bezier(.2,.8,.2,1);display:flex;align-items:flex-start;gap:2px}
    [data-ox-overlay] .cur b{margin-top:13px;padding:3px 7px;border-radius:6px;background:var(--c);color:#111;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.35)}
    [data-ox-overlay] .cur small{display:block;font-weight:500;opacity:.8;max-width:160px;overflow:hidden;text-overflow:ellipsis}
    [data-ox-overlay] .wire{position:fixed;border:1px dashed rgba(127,127,127,.35);border-radius:2px}
    [data-ox-overlay] .hole{position:fixed;border:1px solid rgba(127,127,127,.5);background:linear-gradient(to top right,transparent calc(50% - .5px),rgba(127,127,127,.5) 50%,transparent calc(50% + .5px)),linear-gradient(to bottom right,transparent calc(50% - .5px),rgba(127,127,127,.5) 50%,transparent calc(50% + .5px))}`;
  const ready = () => { document.documentElement.append(style, layer); draw(); };
  const seen = new Map();   // agent name → its drawn parts
  let agents = [], wires = true, shown = true;
  const arrow = (c) => `<svg width="16" height="18" viewBox="0 0 16 18"><path d="M1 1l5 15 2.5-6L15 8z" fill="${c}" stroke="#111" stroke-width="1"/></svg>`;
  const parked = (i) => ({ left: Math.max(12, innerWidth - 230), top: 12 + i * 42, width: 0, height: 0 }); // the corner, off the page's words
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
  const inPage = (el) => !el.closest('[data-ox-overlay]');

  function target(h) {
    if (!h) return null;
    const q = (sel) => { try { return [...document.querySelectorAll(sel)].find((e) => inPage(e) && visible(e)); } catch { return null; } };
    for (const id of h.ids ?? []) { const e = document.getElementById(id); if (e && inPage(e) && visible(e)) return e; }
    for (const c of h.classes ?? []) { const e = q(`.${CSS.escape(c)}`); if (e) return e; }
    for (const t of h.texts ?? []) {
      const e = [...document.querySelectorAll('h1,h2,h3,button,a,p,li,figcaption')].find((x) => inPage(x) && visible(x) && x.textContent.trim().includes(t));
      if (e) return e;
    }
    for (const t of h.tags ?? []) { if (t === 'html' || t === 'body') continue; const e = q(t); if (e) return e; }
    return null;
  }

  function draw() {
    if (!layer.isConnected) return;
    layer.style.display = shown ? '' : 'none';
    const live = new Set();
    agents.forEach((a, i) => {
      live.add(a.name);
      let d = seen.get(a.name);
      if (!d) {
        d = { box: document.createElement('div'), cur: document.createElement('div') };
        d.box.className = 'box'; d.cur.className = 'cur';
        d.box.innerHTML = '<i style="left:-4px;top:-4px"></i><i style="right:-4px;top:-4px"></i><i style="left:-4px;bottom:-4px"></i><i style="right:-4px;bottom:-4px"></i>';
        layer.append(d.box, d.cur); seen.set(a.name, d);
      }
      d.box.style.setProperty('--c', a.color); d.cur.style.setProperty('--c', a.color);
      const el = target(a.hints);
      const r = el ? el.getBoundingClientRect() : parked(i);
      d.box.style.display = el ? '' : 'none';
      if (el) Object.assign(d.box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      const x = el ? r.left + Math.min(r.width * 0.5, 180) : r.left, y = el ? r.top + Math.min(r.height * 0.5, 40) : r.top;
      d.cur.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
      d.cur.innerHTML = `${arrow(a.color)}<b>${esc(a.label)}${el ? '' : `<small>${esc(a.file ?? '')}</small>`}</b>`;
      d.cur.style.opacity = a.active ? '1' : '.45';
      a.el = el;
    });
    for (const [name, d] of seen) if (!live.has(name)) { d.box.remove(); d.cur.remove(); seen.delete(name); }
    drawWires();
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let wireEls = [];
  function drawWires() {
    wireEls.forEach((w) => w.remove()); wireEls = [];
    if (!wires) return;
    // The page's own bones, and a crossed box where a picture has not arrived yet.
    for (const el of document.querySelectorAll('header,nav,main,section,article,aside,footer,img')) {
      if (!inPage(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight) continue;
      const w = document.createElement('div');
      w.className = el.tagName === 'IMG' && !(el.complete && el.naturalWidth) ? 'hole' : 'wire';
      Object.assign(w.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      layer.append(w); wireEls.push(w);
    }
  }

  addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data ?? {};
    if (m.type === 'ox-agents') { agents = m.agents ?? []; wires = m.wires !== false; shown = m.shown !== false; draw(); if (m.follow) { const a = agents.find((x) => x.name === m.follow); const el = a && target(a.hints); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }
    if (m.type === 'ox-css') for (const l of document.querySelectorAll('link[rel="stylesheet"]')) { const u = l.getAttribute('href') ?? ''; if (u.split('?')[0].endsWith(m.file.split('/').pop())) l.setAttribute('href', `${u.split('?')[0]}?t=${Date.now()}`); }
    if (m.type === 'ox-scroll') scrollTo(0, m.y ?? 0);
  });
  let queued = false;
  const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } };
  addEventListener('scroll', later, { passive: true, capture: true });
  addEventListener('resize', later);
  addEventListener('scroll', () => parent.postMessage({ type: 'ox-at', y: scrollY }, '*'), { passive: true });
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready); else ready();
  parent.postMessage({ type: 'ox-ready' }, '*');
})();
