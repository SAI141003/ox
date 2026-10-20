// Steps appear as boxes; an arrow draws itself from each to the next; the current one glows.
function draw(s, t, c) {
  const { stage, state, U, el, esc, spring, ease, BRAND, W, H } = c;
  const items = (s.items ?? []).slice(0, 5);
  const tall = H > W, n = items.length || 1, per = Math.max(0.6, (s.seconds - 1.2) / n);
  if (!state.b) {
    if (s.title) stage.appendChild(el('div', `position:absolute;left:8%;right:8%;top:${tall ? 8 : 10}%;font-weight:800;font-size:6vmin`, esc(s.title)));
    state.b = items.map((x, i) => {
      const pos = tall ? `left:15%;right:15%;top:${22 + i * (68 / n)}%;height:${(68 / n) * 0.6}%` : `top:40%;height:20%;left:${6 + i * (88 / n)}%;width:${(88 / n) * 0.72}%`;
      const b = el('div', `position:absolute;${pos};border-radius:3vmin;border:.6vmin solid ${BRAND.muted};display:flex;align-items:center;justify-content:center;text-align:center;font-size:${tall ? 5 : 3.4}vmin;font-weight:700;padding:1vmin;box-sizing:border-box`, esc(x));
      stage.appendChild(b);
      let a = null;
      if (i < n - 1) {
        a = el('div', tall ? `position:absolute;left:50%;width:.8vmin;background:${BRAND.accent};top:${22 + i * (68 / n) + (68 / n) * 0.6}%;height:${(68 / n) * 0.4}%;transform-origin:top` : `position:absolute;top:50%;height:.8vmin;background:${BRAND.accent};left:${6 + i * (88 / n) + (88 / n) * 0.72}%;width:${(88 / n) * 0.28}%;transform-origin:left`);
        stage.appendChild(a);
      }
      return { b, a };
    });
  }
  state.b.forEach(({ b, a }, i) => {
    const p = spring(t - 0.3 - i * per);
    b.style.opacity = Math.min(1, p * 1.3); b.style.transform = `scale(${0.7 + 0.3 * p})`;
    const on = t >= 0.3 + i * per && (i === n - 1 || t < 0.3 + (i + 1) * per);
    b.style.background = on ? BRAND.accent : 'transparent'; b.style.color = on ? BRAND.bg : BRAND.fg; b.style.borderColor = on ? BRAND.accent : BRAND.muted;
    if (a) { const q = ease((t - 0.3 - i * per - per * 0.5) / (per * 0.5)); a.style.transform = tall ? `scaleY(${q})` : `scaleX(${q})`; }
  });
  stage.style.opacity = 1 - ease((t - (s.seconds - 0.35)) / 0.35);
}
function cues(s) { const n = (s.items ?? []).slice(0, 5).length || 1, per = Math.max(0.6, (s.seconds - 1.2) / n); return Array.from({ length: n }, (_, i) => ({ t: 0.3 + i * per, kind: 'pop' })); }
