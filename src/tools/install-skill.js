// install_skill: "install the strategy-creator skill from github.com/AlphaInsider/skills"
// said in chat does it — through the same scanned installers as the
// Marketplace (src/market.js), then confirms where it went and that ox loads
// it. Approval-gated: it downloads and keeps third-party instructions.
import { install } from '../market.js';

export const INSTALL_SKILL_TOOLS = ['install_skill'];
export const INSTALL_SKILL_KEYWORDS = Object.freeze(['install', 'skill', 'skills', 'plugin', 'github.com', 'marketplace']);

export const INSTALL_SKILL_SCHEMAS = [
  {
    name: 'install_skill',
    description:
      'Install a skill or plugin the user names: a GitHub link (https://github.com/owner/repo, optionally /tree/<branch>/<path> to one skill folder), owner/repo[/path], or name@owner/catalog for a plugin catalogue. Every file is scanned and anything unsafe is refused. Returns where it was installed and whether ox now loads it; tell the user that.',
    input_schema: {
      type: 'object',
      properties: { source: { type: 'string', description: 'GitHub link, owner/repo[/path], or name@owner/repo.' } },
      required: ['source'],
      additionalProperties: false,
    },
  },
];

// A GitHub link in any of its usual shapes -> owner/repo[/path].
export function normalizeSource(src) {
  const s = String(src ?? '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const at = /^([\w.-]+)@([\w.-]+\/[\w.-]+)$/.exec(s);
  if (at) return { name: at[1], catalog: at[2] };
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/[\w.-]+(?:\/(.+?))?)?(?:\/SKILL\.md)?$/i.exec(s);
  if (m) return { repo: `${m[1]}/${m[2]}`, path: m[3] ? m[3].replace(/\/SKILL\.md$/i, '') : null };
  const short = /^([\w.-]+\/[\w.-]+)(?:\/(.+))?$/.exec(s);
  if (short && !s.includes('..')) return { repo: short[1], path: short[2] ?? null };
  return null;
}

export async function installSkillTool(args = {}) {
  const src = normalizeSource(args.source);
  if (!src) return { content: `install_skill: '${args.source}' is not a GitHub link, owner/repo, or name@owner/repo.`, isError: true };
  try {
    const r = src.catalog
      ? await install({ name: src.name, catalog: src.catalog })
      : await install({ repo: src.path ? `${src.repo}/${src.path}` : src.repo });
    return r.ok
      ? { content: `install_skill: ${r.message}. ox loads it from the next turn on (it shows in Capabilities).`, isError: false }
      : { content: `install_skill: not installed — ${r.message}${r.findings ? ` (${r.findings} safety finding(s))` : ''}.`, isError: true };
  } catch (e) {
    return { content: `install_skill: ${e.message}`, isError: true };
  }
}
