// Studio for developers (src/devkit.js) and prices before a paid run (studio-catalog).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const K = await import('../src/devkit.js');
const C = await import('../src/studio-catalog.js');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-devkit-'));

test('one square image becomes every icon the stores and the web ask for', { skip: !hasFfmpeg && 'needs ffmpeg' }, () => {
  const d = tmp();
  const src = path.join(d, 'icon.png');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x7c5cff:s=1024x1024', '-frames:v', '1', src]);
  const r = K.iconSet(src, { out: path.join(d, 'out') });
  const ios = JSON.parse(fs.readFileSync(path.join(d, 'out', 'ios', 'AppIcon.appiconset', 'Contents.json'), 'utf8'));
  assert.equal(ios.images.length, K.IOS_ICONS.length);
  for (const im of ios.images) assert.ok(fs.existsSync(path.join(d, 'out', 'ios', 'AppIcon.appiconset', im.filename)), im.filename);
  const marketing = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', path.join(d, 'out', 'ios', 'AppIcon.appiconset', 'icon-1024@1x-marketing.png')], { encoding: 'utf8' }).stdout.trim();
  assert.equal(marketing, '1024');
  for (const dpi of Object.keys(K.ANDROID)) assert.ok(fs.existsSync(path.join(d, 'out', 'android', `mipmap-${dpi}`, 'ic_launcher.png')));
  assert.ok(fs.existsSync(path.join(d, 'out', 'web', 'apple-touch-icon.png')));
  if (process.platform === 'darwin') assert.ok(fs.existsSync(path.join(d, 'out', 'macos', 'AppIcon.icns')));
  assert.equal(r.warn, null);
  const wide = path.join(d, 'wide.png');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=800x400', '-frames:v', '1', wide]);
  assert.throws(() => K.iconSet(wide, { out: path.join(d, 'w') }), /must be square/);
});

test('prices: free on this Mac, fal\'s listed price for hosted models, before anything runs', () => {
  assert.equal(C.costLine(C.find('mac-image')), 'free on this Mac');
  assert.equal(C.estimateCost(C.find('flux-schnell')), 0.003);
  assert.equal(C.estimateCost(C.find('wan-2.2')), 0.4, '5 s at $0.08 a second');
  assert.equal(C.estimateCost(C.find('hunyuan-video'), { n: 2 }), 0.8);
  assert.match(C.costLine(C.find('wan-2.2')), /^about \$0\.40 on fal$/);
  assert.equal(C.costLine(C.find('esrgan')), '', 'priced by compute time: no estimate claimed');
});
