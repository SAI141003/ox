import { isWriteTool } from './approval.js'
import { classifySegments, parseChain } from './tools/exec.js'

export const READONLY_TOOLS = [
  'read_file', 'list_dir', 'glob', 'grep', 'todo_write',
  'memory_list', 'memory_get', 'memory_search'
]

// Delegate to the canonical classifier in exec.js so the guard pipeline and
// the advisory lint classifier NEVER diverge (same --compress-program,
// find -delete, git-subcommand, redirection, and command-substitution floors).
export function isReadOnlyCommand (cmd) {
  if (!cmd || !cmd.trim()) return true
  return classifySegments(parseChain(cmd)) === 'readonly'
}

export function evaluateToolPolicy ({ name, args, ctx } = {}) {
  ctx = ctx || {}
  const approval = ctx.approval || 'default'
  // --strict-approvals disables the read-only auto-approve ladder: everything
  // prompts (except explicit denies/sandbox blocks which still apply).
  if (ctx.strictApprovals) {
    if (ctx.sandbox && typeof ctx.sandbox.blocksTool === 'function') {
      if (ctx.sandbox.blocksTool(name, args)) return { decision: 'deny', rule: 'sandbox' }
    }
    if (approval === 'plan' && !READONLY_TOOLS.includes(name) && !name.startsWith('memory_')) {
      return { decision: 'deny', rule: 'plan-read-only' }
    }
    return { decision: 'ask', rule: 'strict-approvals' }
  }
  // Sandbox deny is monotonic: it beats yolo/allow everywhere (explicit deny
  // by the confinement backend is non-negotiable, even under --yolo).
  if (ctx.sandbox && typeof ctx.sandbox.blocksTool === 'function') {
    if (ctx.sandbox.blocksTool(name, args)) return { decision: 'deny', rule: 'sandbox' }
  }
  if (approval === 'plan') {
    if (!READONLY_TOOLS.includes(name) && !name.startsWith('memory_')) {
      return { decision: 'deny', rule: 'plan-read-only' }
    }
  }
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    const server = parts[1]
    const pol = ctx.mcpPolicy && ctx.mcpPolicy[server]
    if (pol === 'deny') return { decision: 'deny', rule: 'mcpPolicy' }
    if (pol === 'allow') return { decision: 'allow', rule: 'mcpPolicy' }
    return { decision: 'ask', rule: 'mcpPolicy' }
  }
  if (name === 'bash' && approval === 'default' && args && args.command) {
    if (isReadOnlyCommand(args.command)) return { decision: 'allow', rule: 'readonly-classifier' }
  }
  if (approval === 'yolo') return { decision: 'allow', rule: 'yolo' }
  return { decision: 'ask', rule: 'default' }
}
