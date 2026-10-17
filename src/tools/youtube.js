// youtube_transcript: what a YouTube video says, as text (AgentReach's idea of
// "pull transcripts from YouTube", done without yt-dlp). The caption tracks
// come from YouTube's own player API as its Android app asks for them; the
// watch page's links return empty bodies to plain requests. Read-only, no key.
const UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';
const CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en', gl: 'US' };
const MAX_CHARS = 60_000;

export const YOUTUBE_TOOL_SCHEMAS = Object.freeze([{
  name: 'youtube_transcript',
  description: 'Read what a YouTube video says: its title, channel, length and the full transcript as text with [m:ss] marks every ~30 s. Takes a video link or id; picks the language asked for, else English, else the first one. Use it to summarise, quote or research videos.',
  parameters: {
    type: 'object',
    properties: {
      video: { type: 'string', description: 'A YouTube link (youtube.com/watch?v=…, youtu.be/…, /shorts/…) or the 11-character video id.' },
      lang: { type: 'string', description: 'Language code to prefer, like "en", "es", "hi". Optional.' },
    },
    required: ['video'],
  },
}]);
export const YOUTUBE_TOOLS = Object.freeze(YOUTUBE_TOOL_SCHEMAS.map((s) => s.name));
export const YOUTUBE_SIGNAL = /\b(youtube|youtu\.be|transcript|video)\b/i;

export function videoId(input) {
  const s = String(input ?? '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/.exec(s);
  return m ? m[1] : null;
}

const mmss = (ms) => { const t = Math.floor(ms / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

// json3 caption events -> text with a time mark about every 30 s.
export function transcriptText(json3) {
  const events = Array.isArray(json3?.events) ? json3.events : [];
  let out = '', nextMark = 0;
  for (const e of events) {
    const text = (e.segs ?? []).map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ');
    if (!text.trim()) continue;
    const at = Number(e.tStartMs) || 0;
    if (at >= nextMark) { out += `${out ? '\n' : ''}[${mmss(at)}] `; nextMark = at + 30_000; }
    out += text.endsWith(' ') ? text : `${text} `;
  }
  return out.replace(/ {2,}/g, ' ').replace(/ +\n/g, '\n').trim();
}

export async function youtubeTranscriptTool(args = {}, { fetchImpl = fetch } = {}) {
  const id = videoId(args.video);
  if (!id) return { content: 'youtube_transcript: give a YouTube link or an 11-character video id.', isError: true };
  let player;
  try {
    const r = await fetchImpl('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST', headers: { 'content-type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ videoId: id, context: { client: CLIENT } }), signal: AbortSignal.timeout(15_000),
    });
    player = await r.json();
  } catch (e) {
    return { content: `youtube_transcript: could not reach YouTube (${e?.message ?? e}).`, isError: true };
  }
  const status = player?.playabilityStatus?.status;
  if (status && status !== 'OK') return { content: `youtube_transcript: YouTube says ${status}${player.playabilityStatus.reason ? `: ${player.playabilityStatus.reason}` : ''}.`, isError: true };
  const d = player?.videoDetails ?? {};
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) return { content: `youtube_transcript: "${d.title ?? id}" has no captions or transcript.`, isError: true };
  const want = String(args.lang ?? '').toLowerCase();
  const pick = (want ? tracks.find((t) => t.languageCode === want && t.kind !== 'asr') ?? tracks.find((t) => t.languageCode?.startsWith(want)) : null)
    ?? tracks.find((t) => t.languageCode === 'en' && t.kind !== 'asr') ?? tracks.find((t) => t.languageCode?.startsWith('en')) ?? tracks[0];
  let json3;
  try {
    const r = await fetchImpl(`${String(pick.baseUrl).replace(/&fmt=\w+/, '')}&fmt=json3`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    json3 = await r.json();
  } catch (e) {
    return { content: `youtube_transcript: the transcript could not be read (${e?.message ?? e}).`, isError: true };
  }
  let text = transcriptText(json3);
  if (!text) return { content: `youtube_transcript: the ${pick.languageCode} transcript of "${d.title ?? id}" came back empty.`, isError: true };
  const cut = text.length > MAX_CHARS;
  if (cut) text = `${text.slice(0, MAX_CHARS)}\n[transcript cut at ${MAX_CHARS.toLocaleString('en-US')} characters]`;
  const secs = Number(d.lengthSeconds) || 0;
  const langs = [...new Set(tracks.map((t) => t.languageCode))];
  const head = [
    `${d.title ?? '(untitled)'} — ${d.author ?? 'unknown channel'}`,
    `https://www.youtube.com/watch?v=${id}${secs ? ` · ${mmss(secs * 1000)}` : ''} · transcript: ${pick.languageCode}${pick.kind === 'asr' ? ' (automatic)' : ''}${langs.length > 1 ? ` · also in ${langs.filter((l) => l !== pick.languageCode).slice(0, 12).join(', ')}` : ''}`,
  ].join('\n');
  return { content: `${head}\n\n${text}` };
}
