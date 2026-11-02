// Live wallpapers behind the app: an ASCII cell engine (from
// Zeus-Deus/t3code-wallpapers, MIT) and ox's own scenes. Each is served as a
// page of its own that the app shows in a frame behind everything: it gets no
// clicks, can reach nothing (its CSP allows no requests), pauses while hidden
// and holds still for reduced motion.
import fs from 'node:fs';

export const WALLPAPERS = Object.freeze([
  { id: 'pasture', name: 'Pasture', blurb: 'an ox grazing on the hills at dusk' },
  { id: 'agent-mesh', name: 'Agent Mesh', blurb: 'your agents as stars, messages flying between them' },
  { id: 'embers', name: 'Embers', blurb: 'gold sparks rising from the coals' },
  { id: 'code-rain', name: 'Code Rain', blurb: 'amber code trickling down' },
  { id: 'tide', name: 'Tide', blurb: 'slow swells under a night sky' },
  // From Zeus-Deus/t3code-wallpapers (MIT), as they made them.
  { id: 'koi-pond', name: 'Koi Pond', blurb: 'koi winding between lily pads', from: 't3code-wallpapers' },
  { id: 'moonlit', name: 'Moonlit', blurb: 'a crescent moon, low clouds, shooting stars', from: 't3code-wallpapers' },
  { id: 'jellyfish', name: 'Jellyfish', blurb: 'bells pulsing upward, tentacles trailing', from: 't3code-wallpapers' },
  { id: 'fireflies', name: 'Fireflies', blurb: 'blinking fireflies over swaying grass', from: 't3code-wallpapers' },
  { id: 'honu-lagoon', name: 'Honu Lagoon', blurb: 'sea turtles and a school of fish', from: 't3code-wallpapers' },
  { id: 'paper-boats', name: 'Paper Boats', blurb: 'folded boats drifting down a canal', from: 't3code-wallpapers' },
  { id: 'cloud-drift', name: 'Cloud Drift', blurb: 'puffy clouds at three depths', from: 't3code-wallpapers' },
]);

const dir = new URL('./web/wallpapers/', import.meta.url);

export function wallpaperPage(id) {
  if (!WALLPAPERS.some((w) => w.id === id)) return null;
  const engine = fs.readFileSync(new URL('engine.js', dir), 'utf8');
  const scene = fs.readFileSync(new URL(`scenes/${id}.js`, dir), 'utf8');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${id}</title>
<style>html,body{margin:0;height:100%;overflow:hidden}canvas{display:block}</style>
</head>
<body>
<script>
${engine}
</script>
<script>
${scene}
</script>
</body>
</html>
`;
}
