// Words spring up one after another; the key word takes the accent and an underline sweeps under it.
function draw(s, t, c) {
  const { stage, state, U, el, esc, spring, ease, BRAND } = c;
  const words = String(s.text ?? '').split(/\s+/).filter(Boolean).slice(0, 18);
  const key = words.reduce((b, w, i) => (w.replace(/\W/g, '').length > words[b].replace(/\W/g, '').length ? i : b), 0);
  if (!state.w) {
    const box = el('div', `position:absolute;left:8%;right:8%;top:50%;transform:translateY(-50%);font-weight:800;font-size:${words.length > 9 ? 7.2 : 9.5}vmin;line-height:1.08;letter-spacing:-.02em`);
    state.w = words.map((w, i) => { const sp = el('span', 'display:inline-block;margin-right:.25em;position:relative;will-change:transform', esc(w)); if (i === key) sp.style.color = BRAND.accent; box.appendChild(sp); return sp; });
    state.u = el('div', `position:absolute;left:0;bottom:-.06em;height:.09em;background:${BRAND.accent};border-radius:1em;transform-origin:left`);
    state.w[key].appendChild(state.u);
    stage.appendChild(box);
  }
  state.w.forEach((sp, i) => { const p = spring(t - 0.15 - i * 0.09); sp.style.transform = `translateY(${(1 - p) * 60}px) scale(${0.85 + 0.15 * p})`; sp.style.opacity = Math.min(1, p * 1.4); });
  const end = 0.15 + words.length * 0.09 + 0.3;
  state.u.style.transform = `scaleX(${ease((t - end) / 0.5)})`;
  stage.style.opacity = 1 - ease((t - (s.seconds - 0.35)) / 0.35);
}
function cues(s) { const n = String(s.text ?? '').split(/\s+/).length; return [{ t: 0.12, kind: 'whoosh' }, { t: 0.15 + n * 0.09 + 0.3, kind: 'pop' }]; }
