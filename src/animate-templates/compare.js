// Two cards fly in from each side; "vs" punches in between; the right one wins the accent.
function draw(s, t, c) {
  const { stage, state, U, el, esc, spring, ease, BRAND, W, H } = c;
  const tall = H > W;
  if (!state.a) {
    const card = (txt, win) => el('div', `position:absolute;${tall ? 'left:10%;right:10%;height:28%' : 'top:25%;bottom:25%;width:36%'};border-radius:4vmin;display:flex;align-items:center;justify-content:center;text-align:center;padding:4vmin;box-sizing:border-box;font-size:6.5vmin;font-weight:800;${win ? `background:${BRAND.accent};color:${BRAND.bg}` : `background:rgba(255,255,255,.07);border:.5vmin solid rgba(255,255,255,.15)`}`, esc(txt));
    state.a = card(s.left ?? '', false); state.b = card(s.right ?? '', true);
    if (tall) { state.a.style.top = '14%'; state.b.style.bottom = '14%'; } else { state.a.style.left = '8%'; state.b.style.right = '8%'; }
    state.v = el('div', `position:absolute;left:50%;top:50%;font-size:9vmin;font-weight:900;color:${BRAND.muted};font-style:italic`, 'vs');
    stage.append(state.a, state.b, state.v);
  }
  const pa = spring(t - 0.15), pb = spring(t - 0.55), pv = spring(t - 1.0, { stiff: 300, damp: 10 });
  state.a.style.transform = tall ? `translateY(${(1 - pa) * -60}vh)` : `translateX(${(1 - pa) * -60}vw)`;
  state.b.style.transform = tall ? `translateY(${(1 - pb) * 60}vh) scale(${1 + 0.04 * ease((t - 1.6) / 0.4)})` : `translateX(${(1 - pb) * 60}vw) scale(${1 + 0.04 * ease((t - 1.6) / 0.4)})`;
  state.v.style.transform = `translate(-50%,-50%) scale(${pv})`;
  stage.style.opacity = 1 - ease((t - (s.seconds - 0.35)) / 0.35);
}
function cues() { return [{ t: 0.13, kind: 'whoosh' }, { t: 0.53, kind: 'whoosh' }, { t: 1.0, kind: 'pop' }]; }
