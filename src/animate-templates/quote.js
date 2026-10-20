// The quote types itself out with a blinking caret; big quote marks fade in behind it.
function draw(s, t, c) {
  const { stage, state, el, esc, ease, BRAND } = c;
  const text = String(s.text ?? '');
  if (!state.q) {
    stage.appendChild(el('div', `position:absolute;left:6%;top:12%;font-size:40vmin;line-height:1;color:${BRAND.accent};opacity:.18;font-family:Georgia,serif`, '“'));
    state.q = el('div', `position:absolute;left:10%;right:10%;top:50%;transform:translateY(-50%);font-size:${text.length > 90 ? 5.2 : 7}vmin;font-weight:700;line-height:1.25`);
    state.by = el('div', `position:absolute;left:10%;right:10%;bottom:16%;font-size:4.5vmin;color:${BRAND.muted}`, s.by ? `— ${esc(s.by)}` : '');
    stage.append(state.q, state.by);
  }
  const speed = Math.max(18, text.length / Math.max(1, s.seconds - 1.6));
  const n = Math.floor(Math.max(0, t - 0.3) * speed);
  const caret = Math.floor(t * 2.2) % 2 ? '' : `<span style="color:${BRAND.accent}">▍</span>`;
  state.q.innerHTML = esc(text.slice(0, n)) + (n < text.length ? `<span style="color:${BRAND.accent}">▍</span>` : caret);
  state.by.style.opacity = ease((t - 0.3 - text.length / speed) / 0.5);
  stage.style.opacity = 1 - ease((t - (s.seconds - 0.35)) / 0.35);
}
function cues(s) { const text = String(s.text ?? ''); const speed = Math.max(18, text.length / Math.max(1, s.seconds - 1.6)); const out = []; for (let i = 0; i < text.length; i += 3) if (text[i] !== ' ') out.push({ t: 0.3 + i / speed, kind: 'click' }); return out.slice(0, 60); }
