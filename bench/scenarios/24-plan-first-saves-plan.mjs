import { turn } from '../harness.mjs';

export default {
  name: '24-plan-first-saves-plan',
  description: '--plan saves a plan to .agent/plans/',
  category: 'planning',
  prompt: 'Build a new feature',
  extraArgs: ['--plan'],
  tokensPerTurn: { in: 800, out: 80 },

  async script(body, ws, state) {
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (!hasTools) {
      state.flags.planRequest = true;
      return turn({
        text: '{"goal": "Build a new feature", "steps": [{"title": "Explore codebase", "tools": ["list_dir", "read_file"]}, {"title": "Implement feature", "tools": ["write_file"]}, {"title": "Verify", "tools": ["bash"]}]}',
        usage: { in: 600, out: 120 }
      });
    }
    state.flags.taskRequest = true;
    return turn({ text: 'I will build the new feature now.', usage: { in: 700, out: 40 } });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode} stderr=${r.stderr.slice(0, 200)}` };
    const fs = await import('node:fs');
    const path = await import('node:path');
    const plansDir = path.join(r.ws, '.agent', 'plans');
    if (!fs.existsSync(plansDir)) return { pass: false, detail: '.agent/plans/ directory missing' };
    const files = fs.readdirSync(plansDir).filter((f) => f.endsWith('.json'));
    if (!files.length) return { pass: false, detail: 'no JSON plan files in .agent/plans/' };
    const planContent = fs.readFileSync(path.join(plansDir, files[0]), 'utf8');
    let plan;
    try { plan = JSON.parse(planContent); } catch { return { pass: false, detail: 'plan file is not valid JSON' }; }
    if (!plan.plan || !plan.plan.goal) return { pass: false, detail: 'plan JSON missing plan.goal' };
    return { pass: true, detail: `plan saved to .agent/plans/${files[0]}` };
  },
};
