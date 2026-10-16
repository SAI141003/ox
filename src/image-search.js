// Pictures in answers (SearchImage in OpenUI Lang): the best Wikipedia match for
// a query, fetched by ox and kept in ~/.ox/cache/images, so the app page loads
// nothing from outside and a picture asked for twice costs nothing. Free, no
// account; only Wikimedia's image hosts are ever fetched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CACHE = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'cache', 'images');
const UA = { 'User-Agent': 'ox-agent/0.1 (local assistant; https://github.com/ox)' };
const ALLOWED = /^https:\/\/(upload|thumb)\.wikimedia\.org\//;

export async function findImage(query, { fetchImpl = fetch, width = 800 } = {}) {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!q) return null;
  const key = crypto.createHash('sha1').update(`${q.toLowerCase()}|${width}`).digest('hex').slice(0, 20);
  const dir = CACHE();
  const file = path.join(dir, `${key}.img`), meta = path.join(dir, `${key}.json`);
  if (fs.existsSync(file) && fs.existsSync(meta)) return { file, ...JSON.parse(fs.readFileSync(meta, 'utf8')) };
  const api = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=5&prop=pageimages&piprop=thumbnail&pithumbsize=${width}&format=json&origin=*`;
  const r = await fetchImpl(api, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const pages = Object.values((await r.json()).query?.pages ?? {}).filter((p) => p.thumbnail?.source).sort((a, b) => a.index - b.index);
  const best = pages[0];
  if (!best || !ALLOWED.test(best.thumbnail.source)) return null;
  const img = await fetchImpl(best.thumbnail.source, { headers: UA, signal: AbortSignal.timeout(12000) });
  const type = img.headers.get('content-type') ?? '';
  if (!img.ok || !/^image\/(jpeg|png|webp|gif)/.test(type)) return null;
  const buf = Buffer.from(await img.arrayBuffer());
  if (buf.length > 4_000_000) return null;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buf);
  const info = { type, title: best.title, credit: `Wikipedia: ${best.title}`, page: `https://en.wikipedia.org/?curid=${best.pageid}` };
  fs.writeFileSync(meta, JSON.stringify(info));
  return { file, ...info };
}
