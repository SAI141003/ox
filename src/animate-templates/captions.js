// Kinetic captions: three or four words at a time, the spoken word lit, timed across the scene.
function draw(s, t, c) {
  const { stage, state, el, esc, spring, ease, BRAND } = c;
  const words = String(s.text ?? '').split(/\s+/).filter(Boolean);
  const per = Math.max(0.18, (s.seconds - 0.6) / Math.max(1, words.length));
  const group = 4;
  if (!state.box) { state.box = el('div', `position:absolute;left:8%;right:8%;top:50%;transform:translateY(-50%);text-align:center;font-size:9vmin;font-weight:900;line-height:1.1;letter-spacing:-.02em;text-transform:uppercase`); stage.appendChild(state.box); }
  const i = Math.min(words.length - 1, Math.max(0, Math.floor((t - 0.2) / per)));
  const g = Math.floor(i / group);
  if (state.g !== g) { state.g = g; state.since = (0.2 + g * group * per); state.box.innerHTML = words.slice(g * group, g * group + group).map((w, k) => `<span data-k="${g * group + k}" style="display:inline-block;margin:0 .15em">${esc(w)}</span>`).join(' '); }
  state.box.querySelectorAll('span').forEach((sp) => { const k = Number(sp.dataset.k); sp.style.color = k === i ? BRAND.accent : k < i ? BRAND.fg : 'rgba(255,255,255,.35)'; sp.style.transform = k === i ? `scale(${1 + 0.08 * spring(t - 0.2 - k * per, { stiff: 300, damp: 12 })})` : 'scale(1)'; });
  const p = spring(t - state.since);
  state.box.style.transform = `translateY(-50%) translateY(${(1 - p) * 30}px)`;
  stage.style.opacity = 1 - ease((t - (s.seconds - 0.25)) / 0.25);
}
function cues(s) { const words = String(s.text ?? '').split(/\s+/).filter(Boolean); const per = Math.max(0.18, (s.seconds - 0.6) / Math.max(1, words.length)); const out = []; for (let g = 0; g * 4 < words.length; g++) out.push({ t: 0.2 + g * 4 * per, kind: 'whoosh' }); return out; }
