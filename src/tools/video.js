// edit_video: "cut the first 10 seconds", "add captions", "make a 9:16 short",
// "find where I talk about pricing", "speed this up 2x", "polish this screen
// recording", "what happens in this video?" — on this machine with ffmpeg and
// whisper.cpp (src/video-edit.js). Results are new files beside the source.
import * as V from '../video-edit.js';

export const VIDEO_TOOL_SCHEMAS = [{
  name: 'edit_video',
  description: 'Edit or understand a local video file. ops: transcribe (speech to timed text), captions (burn the transcript in), cut (start/end), speed (factor), vertical (aspect 9:16 or 1:1), highlights (query: the words spoken in the parts to keep), gif, polish (speed up still parts of a screen recording, padded background), understand (frames at scene changes + transcript). The source is never changed; tell the user the new file path.',
  input_schema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['transcribe', 'captions', 'cut', 'speed', 'vertical', 'highlights', 'gif', 'polish', 'understand'] },
      file: { type: 'string', description: 'Path to the video.' },
      start: { type: 'string', description: 'cut/gif: start time (83, 1:23 or 00:01:23).' },
      end: { type: 'string', description: 'cut/gif: end time.' },
      factor: { type: 'number', description: 'speed: 2 = twice as fast, 0.5 = half speed.' },
      aspect: { type: 'string', description: 'vertical: 9:16 (default) or 1:1.' },
      query: { type: 'string', description: 'highlights: what is talked about in the parts to keep.' },
    },
    required: ['op', 'file'],
    additionalProperties: false,
  },
}];

export async function editVideoTool(args = {}, ctx = {}) {
  const file = String(args.file ?? '');
  const abs = file.startsWith('/') || file.startsWith('~') ? file.replace(/^~(?=\/)/, process.env.HOME ?? '') : `${ctx.cwd ?? process.cwd()}/${file}`;
  try {
    let r;
    switch (args.op) {
      case 'transcribe': { const t = V.transcribe(abs); return { content: t.segments.length ? `${t.segments.map((s) => `[${s.start.toFixed(1)}s] ${s.text}`).join('\n')}\n\n(transcript saved: ${t.srt})` : `edit_video: ${t.note ?? 'no speech found'}`, isError: false }; }
      case 'captions': r = V.captions(abs); return { content: `edit_video: captioned (${r.lines} lines, ${r.burned ? 'burned in' : 'as a subtitle track'}): ${r.file}`, isError: false };
      case 'cut': r = V.cut(abs, args.start ?? 0, args.end ?? null); break;
      case 'speed': r = V.speed(abs, args.factor ?? 2); break;
      case 'vertical': r = V.vertical(abs, args.aspect ?? '9:16'); break;
      case 'gif': r = V.gif(abs, { start: args.start ?? null, end: args.end ?? null }); break;
      case 'highlights': r = V.highlights(abs, args.query ?? ''); if (!r.file) return { content: `edit_video: ${r.note}`, isError: false }; return { content: `edit_video: ${r.found} part(s) joined: ${r.file}\n${r.parts.map((p) => `- ${p.start}s–${p.end}s: ${p.text}`).join('\n')}`, isError: false };
      case 'polish': r = V.polish(abs); return { content: `edit_video: polished ${r.before}s → ${r.after}s (${r.stillParts} still part(s) sped up): ${r.file}`, isError: false };
      case 'understand': { const u = V.understand(abs); return { content: `edit_video: ${Math.round(u.duration)}s, ${u.size}. Frames (view them with read_file): ${u.frames.map((f) => `${f.at}s ${f.file}`).join(', ')}\n\nTranscript:\n${u.text || '(no speech)'}`, isError: false }; }
      default: return { content: `edit_video: unknown op ${args.op}`, isError: true };
    }
    return { content: `edit_video: ${args.op} done: ${r.file}`, isError: false };
  } catch (e) {
    return { content: `edit_video: ${e.message}`, isError: true };
  }
}
