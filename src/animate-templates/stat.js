// The number counts up with ticks, a ring fills, and the label slides in under it.
function draw(s, t, c) {
  const { stage, state, U, el, esc, ease, spring, BRAND } = c;
  const raw = String(s.value ?? '0');
  const m = /^(\D*)([\d,.]+)(.*)$/.exec(raw) ?? ['', '', '0', ''];
  const target = Number(m[2].replace(/,/g, '')) || 0;
  const dec = (m[2].split('.')[1] ?? '').length;
  if (!state.n) {
    const R = 30 * U;
    stage.appendChild(el('div', `position:absolute;left:50%;top:42%;width:${R * 2}px;height:${R * 2}px;transform:translate(-50%,-50%)`, `<svg width="${R * 2}" height="${R * 2}" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="none" stroke="${BRAND.muted}" stroke-opacity=".25" stroke-width="5"/><circle id="ring" cx="50" cy="50" r="44" fill="none" stroke="${BRAND.accent}" stroke-width="5" stroke-linecap="round" stroke-dasharray="276.5" stroke-dashoffset="276.5" transform="rotate(-90 50 50)"/></svg>`));
    state.n = el('div', `position:absolute;left:0;right:0;top:42%;transform:translateY(-50%);text-align:center;font-weight:800;font-size:${raw.length > 6 ? 13 : 17}vmin;letter-spacing:-.03em`);
    state.l = el('div', `position:absolute;left:10%;right:10%;top:${42 + 36 * U / c.H * 100}%;text-align:center;font-size:5vmin;color:${BRAND.muted};font-weight:600`, esc(s.label ?? ''));
    stage.append(state.n, state.l);
    state.ring = stage.querySelector('#ring');
  }
  const p = ease((t - 0.2) / 1.4);
  state.n.textContent = `${m[1]}${(target * p).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}${m[3]}`;
  state.n.style.transform = `translateY(-50%) scale(${0.7 + 0.3 * spring(t - 0.05)})`;
  const pct = /%/.test(raw) ? Math.min(1, target / 100) : 1;
  state.ring.setAttribute('stroke-dashoffset', String(276.5 * (1 - pct * p)));
  const lp = spring(t - 1.3);
  state.l.style.opacity = lp; state.l.style.transform = `translateY(${(1 - lp) * 40}px)`;
  stage.style.opacity = 1 - ease((t - (s.seconds - 0.35)) / 0.35);
}
function cues() { const out = [{ t: 0.05, kind: 'whoosh' }]; for (let i = 0; i < 10; i++) out.push({ t: 0.25 + i * 0.13, kind: 'tick' }); out.push({ t: 1.35, kind: 'pop' }); return out; }
