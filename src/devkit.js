// Studio for developers: the assets an app needs, made on this machine with
// what macOS and ox already have (sips, iconutil, headless Chrome, ffmpeg).
//
//   icons   one square image → an iOS AppIcon.appiconset, a macOS .icns,
//           Android mipmaps and a web favicon set (with a manifest).
//   shots   app screenshots → store-sized pictures (App Store 6.9"/6.5"/iPad,
//           Google Play) with a headline over a soft background.
//   demo    screenshots + captions → a short vertical demo video: each screen
//           slides in with its caption, crossfades, at 30 fps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || '').trim().slice(-300)}`);
  return r.stdout;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function size(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [w, h] = String(r.stdout ?? '').trim().split(',').map(Number);
  if (!w || !h) throw new Error(`not an image: ${file}`);
  return { w, h };
}

// A square PNG at n×n: sips on macOS, ffmpeg elsewhere.
function resize(src, n, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (process.platform === 'darwin') run('sips', ['-s', 'format', 'png', '-z', String(n), String(n), src, '--out', out]);
  else run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vf', `scale=${n}:${n}:flags=lanczos`, out]);
  return out;
}

export const IOS_ICONS = [
  [20, 2, 'iphone'], [20, 3, 'iphone'], [29, 2, 'iphone'], [29, 3, 'iphone'], [40, 2, 'iphone'], [40, 3, 'iphone'], [60, 2, 'iphone'], [60, 3, 'iphone'],
  [20, 1, 'ipad'], [20, 2, 'ipad'], [29, 1, 'ipad'], [29, 2, 'ipad'], [40, 1, 'ipad'], [40, 2, 'ipad'], [76, 1, 'ipad'], [76, 2, 'ipad'], [83.5, 2, 'ipad'],
  [1024, 1, 'ios-marketing'],
];
export const ANDROID = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

/** One square image → every icon size the stores and the web ask for. → { dir, files } */
export function iconSet(src, { out = null, name = 'AppIcon' } = {}) {
  if (!fs.existsSync(src)) throw new Error(`no image at ${src}`);
  const { w, h } = size(src);
  if (w !== h) throw new Error(`the icon must be square (this one is ${w}×${h}); crop it first`);
  const warn = w < 1024 ? `the source is ${w}px; 1024px or more looks sharp in the App Store` : null;
  const dir = out ?? path.join(process.cwd(), `${name}-icons`);
  const files = [];
  // iOS
  const ios = path.join(dir, 'ios', `${name}.appiconset`);
  const images = IOS_ICONS.map(([pt, scale, idiom]) => {
    const px = Math.round(pt * scale);
    const filename = `icon-${pt}@${scale}x${idiom === 'ipad' ? '-ipad' : idiom === 'ios-marketing' ? '-marketing' : ''}.png`;
    files.push(resize(src, px, path.join(ios, filename)));
    return { size: `${pt}x${pt}`, idiom, filename, scale: `${scale}x` };
  });
  fs.writeFileSync(path.join(ios, 'Contents.json'), JSON.stringify({ images, info: { version: 1, author: 'ox' } }, null, 2));
  // macOS .icns (iconutil, macOS only)
  if (process.platform === 'darwin') {
    const set = path.join(os.tmpdir(), `ox-${process.pid}-${Date.now()}.iconset`);
    for (const n of [16, 32, 128, 256, 512]) { resize(src, n, path.join(set, `icon_${n}x${n}.png`)); resize(src, n * 2, path.join(set, `icon_${n}x${n}@2x.png`)); }
    const icns = path.join(dir, 'macos', `${name}.icns`);
    fs.mkdirSync(path.dirname(icns), { recursive: true });
    run('iconutil', ['-c', 'icns', set, '-o', icns]);
    fs.rmSync(set, { recursive: true, force: true });
    files.push(icns);
  }
  // Android
  for (const [d, n] of Object.entries(ANDROID)) files.push(resize(src, n, path.join(dir, 'android', `mipmap-${d}`, 'ic_launcher.png')));
  files.push(resize(src, 512, path.join(dir, 'android', 'play-store-512.png')));
  // Web
  for (const n of [16, 32, 48]) files.push(resize(src, n, path.join(dir, 'web', `favicon-${n}.png`)));
  files.push(resize(src, 180, path.join(dir, 'web', 'apple-touch-icon.png')));
  for (const n of [192, 512]) files.push(resize(src, n, path.join(dir, 'web', `icon-${n}.png`)));
  const ico = path.join(dir, 'web', 'favicon.ico');
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(dir, 'web', 'favicon-48.png'), ico]);
  if (fs.existsSync(ico)) files.push(ico);
  fs.writeFileSync(path.join(dir, 'web', 'site.webmanifest'), JSON.stringify({ icons: [192, 512].map((n) => ({ src: `icon-${n}.png`, sizes: `${n}x${n}`, type: 'image/png' })) }, null, 2));
  return { dir, files, warn };
}

/** Store screenshot sizes (portrait). */
export const STORE_SIZES = Object.freeze({
  'iphone-6.9': [1320, 2868], 'iphone-6.5': [1242, 2688], 'ipad-13': [2064, 2752], 'play-phone': [1080, 1920],
});

function shotPage(img, caption, [W, H], { bg = '#0f1117', fg = '#ffffff', accent = '#7c5cff' } = {}) {
  const data = `data:image/png;base64,${fs.readFileSync(img).toString('base64')}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:radial-gradient(${W}px ${H * 0.7}px at 50% 0%, ${accent}55, ${bg} 70%);font-family:-apple-system,"SF Pro Display","Inter",Helvetica,Arial,sans-serif;color:${fg}}
h1{position:absolute;left:7%;right:7%;top:${H * 0.05}px;margin:0;text-align:center;font-size:${Math.round(W * 0.075)}px;line-height:1.1;font-weight:800;letter-spacing:-.02em}
.stage{position:absolute;left:0;right:0;top:${H * 0.17}px;bottom:${H * 0.04}px;display:flex;align-items:center;justify-content:center}
.dev{max-width:${Math.round(W * 0.82)}px;max-height:100%;border-radius:${Math.round(W * 0.06)}px;overflow:hidden;box-shadow:0 ${W * 0.03}px ${W * 0.08}px rgba(0,0,0,.45);border:${Math.max(4, Math.round(W * 0.012))}px solid #1c1f27;background:#000}
.dev img{display:block;max-width:${Math.round(W * 0.82)}px;max-height:${Math.round(H * 0.79)}px}
</style></head><body><h1>${esc(caption)}</h1><div class="stage"><div class="dev"><img src="${data}"></div></div></body></html>`;
}

/**
 * Screenshots → framed store pictures with a headline each, for every size
 * asked. → { dir, files }
 */
export async function storeShots(images, { captions = [], sizes = ['iphone-6.9', 'play-phone'], out = null, colors = {} } = {}) {
  const D = await import('./dev-flow.js');
  if (!images.length) throw new Error('give one or more app screenshots');
  const dir = out ?? path.join(process.cwd(), 'store-screenshots');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-shots-'));
  const files = [];
  for (const sz of sizes) {
    const dims = STORE_SIZES[sz];
    if (!dims) throw new Error(`sizes: ${Object.keys(STORE_SIZES).join(', ')}`);
    for (const [i, img] of images.entries()) {
      const html = path.join(work, `${sz}-${i}.html`);
      fs.writeFileSync(html, shotPage(img, captions[i] ?? '', dims, colors));
      const file = path.join(dir, sz, `${String(i + 1).padStart(2, '0')}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      D.screenshot(`file://${html}`, file, { width: dims[0], height: dims[1] });
      files.push(file);
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  return { dir, files };
}

/**
 * Screenshots + captions → a vertical demo video (1080×1920): each screen in a
 * frame with its caption, a slow push-in, crossfades. → { file, seconds }
 */
export async function demoVideo(images, { captions = [], secondsEach = 3, out = null, colors = {} } = {}) {
  if (!images.length) throw new Error('give one or more app screenshots');
  const { files } = await storeShots(images, { captions, sizes: ['play-phone'], out: fs.mkdtempSync(path.join(os.tmpdir(), 'ox-demo-')), colors });
  const fade = 0.5;
  // Each picture once: zoompan turns one input frame into the whole clip (a
  // looped input would make d frames out of EVERY frame).
  const inputs = files.flatMap((f) => ['-i', f]);
  const frames = Math.round((secondsEach + fade) * 30);
  let chain = files.map((_, i) => `[${i}:v]scale=1080:1920,zoompan=z='min(zoom+0.0006,1.06)':d=${frames}:s=1080x1920:fps=30,format=yuv420p,setsar=1[p${i}]`).join(';');
  let last = 'p0';
  for (let i = 1; i < files.length; i++) { chain += `;[${last}][p${i}]xfade=transition=slideleft:duration=${fade}:offset=${(secondsEach * i - fade * (i - 1)).toFixed(2)}[x${i}]`; last = `x${i}`; }
  const file = out ?? path.join(process.cwd(), 'app-demo.mp4');
  run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', chain, '-map', `[${last}]`, '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
  return { file, seconds: Math.round((secondsEach * files.length - fade * (files.length - 1) + fade) * 10) / 10 };
}
