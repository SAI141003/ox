// Items slide in one by one from the left; each gets its check as it lands.
function draw(s, t, c) {
  const { stage, state, U, el, esc, spring, ease, BRAND } = c;
  const items = (s.items ?? []).slice(0, 5);
  if (!state.rows) {
    if (s.title) stage.appendChild(state.h = el('div', `position:absolute;left:9%;right:9%;top:16%;font-weight:800;font-size:7vmin;letter-spacing:-.02em`, esc(s.title)));
    const top = s.title ? 30 : 22;
    state.rows = items.map((x, i) => {
      const r = el('div', `position:absolute;left:9%;right:9%;top:${top + i * (60 / Math.max(items.length, 3))}%;display:flex;align-items:center;gap:4vmin;font-size:6vmin;font-weight:700`);
      const dot = el('div', `flex:none;width:9vmin;height:9vmin;border-radius:2.4vmin;background:${BRAND.accent};color:${BRAND.bg};display:flex;align-items:center;justify-content:center;font-size:5.5vmin`, '✓');
      r.append(dot, el('div', '', esc(x)));
      stage.appendChild(r);
      return { r, dot };
    });
  }
  if (state.h) { const p = spring(t); state.h.style.opacity = p; state.h.style.transform = `translateY(${(1 - p) * -30}px)`; }
  state.rows.forEach(({ r, dot }, i) => {
    const p = spring(t - 0.35 - i * 0.45);
    r.style.opacity = Math.min(1, p * 1.3); r.style.transform = `translateX(${(1 - p) * -120}px)`;
    dot.style.transform = `scale(${spring(t - 0.6 - i * 0.45, { stiff: 260, damp: 12 })})`;
  });
  stage.style.opacity = 1 - ease((t - (s.seconds - 0.35)) / 0.35);
}
function cues(s) { return (s.items ?? []).slice(0, 5).flatMap((_, i) => [{ t: 0.33 + i * 0.45, kind: 'whoosh' }, { t: 0.62 + i * 0.45, kind: 'pop' }]); }
