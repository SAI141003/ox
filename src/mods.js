// Ox-native companion “mods”. A mod is a presentation preset for a bot and
// the Island: it gives the same work a clear identity (colour, expression and
// status label) without bundling or copying another product's artwork.
//
// The names mirror the references users commonly bring to Ox, but the visual
// treatment stays Ox-owned and editable. A mod never changes provider routing
// or grants tools; it is a safe UI/persona preset only.
export const MODS = Object.freeze([
  { id: 'claude', name: 'Claude', description: 'Calm, careful review mode.', bot: 'ox-claude', color: 'coral', expression: 'focused', islandLabel: 'reviewing' },
  { id: 'grok-bot', name: 'Grok Bot', description: 'Fast, direct iteration mode.', bot: 'ox-grok', color: 'violet', expression: 'alert', islandLabel: 'moving fast' },
  { id: 'meta-muse', name: 'Meta Muse', description: 'Idea generation and exploration.', bot: 'ox-gpt', color: 'peach', expression: 'curious', islandLabel: 'exploring' },
  { id: 'dots', name: 'Dots', description: 'Friendly, lightweight everyday help.', bot: 'ox-flash', color: 'gold', expression: 'bright', islandLabel: 'ready' },
  { id: 'claude-widget', name: 'Claude Widget', description: 'Compact desktop status companion.', bot: 'ox-claude', color: 'orange', expression: 'quiet', islandLabel: 'standing by' },
  { id: 'ox-mods', name: 'Ox Mods', description: 'The original editable Ox preset.', bot: 'ox-ollama', color: 'blue', expression: 'neutral', islandLabel: 'local' },
]);

export function listMods() { return MODS.map((m) => ({ ...m })); }
export function findMod(id) { return MODS.find((m) => m.id === String(id)) ?? null; }
