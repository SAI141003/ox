export const MAX_STACK_SIZE = 128;

export const AAS_MCP_TOOLS = [
  { name: 'search_skills', description: 'Search skills by query, category, limit', inputSchema: { type: 'object', properties: { query: { type: 'string' }, category: { type: 'string' }, limit: { type: 'number', minimum: 1, maximum: 100 } }, required: ['query'] } },
  { name: 'get_skill', description: 'Get full skill object by ID', inputSchema: { type: 'object', properties: { skillId: { type: 'string' } }, required: ['skillId'] } },
  { name: 'list_skill_files', description: 'List files for a skill', inputSchema: { type: 'object', properties: { skillId: { type: 'string' } }, required: ['skillId'] } },
  { name: 'read_skill_file', description: 'Read content of a skill file', inputSchema: { type: 'object', properties: { skillId: { type: 'string' }, filePath: { type: 'string' } }, required: ['skillId', 'filePath'] } },
  { name: 'compose_stack', description: 'Validate and compose a skill stack', inputSchema: { type: 'object', properties: { skillIds: { type: 'array', items: { type: 'string' } }, evidence: { type: 'boolean' } }, required: ['skillIds'] } },
  { name: 'inspect_stack', description: 'Inspect current in-memory stack', inputSchema: { type: 'object', properties: { stack: { type: 'array', items: { type: 'string' } } } } },
  { name: 'diff_stack', description: 'Diff two skill stacks', inputSchema: { type: 'object', properties: { stack1: { type: 'array', items: { type: 'string' } }, stack2: { type: 'array', items: { type: 'string' } } }, required: ['stack1', 'stack2'] } },
  { name: 'export_selection_evidence', description: 'Export selection evidence for skills', inputSchema: { type: 'object', properties: { skillIds: { type: 'array', items: { type: 'string' } } }, required: ['skillIds'] } },
  { name: 'inspect_selection_evidence', description: 'Inspect and validate selection evidence', inputSchema: { type: 'object', properties: { evidence: { type: 'object' } }, required: ['evidence'] } }
];

export class AASCoreMcp {
  constructor({ catalog = [] }) {
    this.catalog = catalog;
    this.skillIndex = new Map(catalog.map(s => [s.id, s]));
    this.currentStack = [];
  }

  searchSkills({ query, category, limit = 20 }) {
    const q = query.toLowerCase();
    let results = this.catalog.filter(s => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
    if (category) results = results.filter(s => s.category === category);
    return { skills: results.slice(0, limit).map(s => ({ id: s.id, name: s.name, category: s.category, description: s.description })), count: results.length };
  }

  getSkill({ skillId }) {
    const skill = this.skillIndex.get(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);
    return skill;
  }

  listSkillFiles({ skillId }) {
    const skill = this.skillIndex.get(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);
    return { files: (skill.files || []).map(f => ({ path: f.path, size: f.size })) };
  }

  readSkillFile({ skillId, filePath }) {
    const skill = this.skillIndex.get(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);
    const file = (skill.files || []).find(f => f.path === filePath);
    if (!file) throw new Error(`File not found: ${filePath}`);
    return { content: file.content || '' };
  }

  composeStack({ skillIds, evidence = false }) {
    const errors = [], warnings = [], seen = new Set(), cats = new Map();
    for (const id of skillIds) {
      if (seen.has(id)) { errors.push(`Duplicate skill ID: ${id}`); continue; }
      seen.add(id);
      const skill = this.skillIndex.get(id);
      if (!skill) { errors.push(`Skill not found: ${id}`); continue; }
      if (cats.has(skill.category)) warnings.push(`Multiple skills from category "${skill.category}": ${cats.get(skill.category)} and ${id}`);
      else cats.set(skill.category, id);
    }
    if (skillIds.length > MAX_STACK_SIZE) errors.push(`Stack exceeds max size of ${MAX_STACK_SIZE} (got ${skillIds.length})`);
    const valid = errors.length === 0;
    if (valid && evidence) this.currentStack = [...skillIds];
    return { valid, errors, warnings, skillCount: skillIds.length, maxSkills: MAX_STACK_SIZE };
  }

  inspectStack({ stack }) {
    return stack ? { stack } : (this.currentStack.length ? { stack: this.currentStack } : { message: 'no stack' });
  }

  diffStack({ stack1, stack2 }) {
    const s1 = new Set(stack1), s2 = new Set(stack2);
    return { added: stack2.filter(id => !s1.has(id)), removed: stack1.filter(id => !s2.has(id)), unchanged: stack1.filter(id => s2.has(id)) };
  }

  exportSelectionEvidence({ skillIds }) {
    const now = new Date().toISOString();
    const capabilityLedger = {}, processTrace = [];
    for (const id of skillIds) {
      const skill = this.skillIndex.get(id);
      if (skill) { capabilityLedger[id] = { category: skill.category, name: skill.name }; processTrace.push({ skillId: id, action: 'selected', timestamp: now }); }
    }
    return { evidence: { selectedAt: now, skillIds, capabilityLedger, processTrace } };
  }

  inspectSelectionEvidence({ evidence }) {
    const checks = [];
    if (!evidence || typeof evidence !== 'object') return { valid: false, checks: [{ check: 'structure', pass: false, message: 'Evidence must be an object' }] };
    const required = ['selectedAt', 'skillIds', 'capabilityLedger', 'processTrace'];
    if (!required.every(k => evidence[k])) return { valid: false, checks: [{ check: 'required_fields', pass: false, message: 'Missing required fields' }] };
    checks.push({ check: 'required_fields', pass: true, message: 'All required fields present' });
    for (const id of evidence.skillIds || []) {
      if (!this.skillIndex.has(id)) return { valid: false, checks: [{ check: 'skill_exists', pass: false, message: `Skill not in catalog: ${id}` }] };
    }
    checks.push({ check: 'skill_exists', pass: true, message: 'All skills exist in catalog' });
    return { valid: true, checks };
  }

  handleRequest(method, params, id) {
    const handlers = {
      search_skills: () => this.searchSkills(params),
      get_skill: () => this.getSkill(params),
      list_skill_files: () => this.listSkillFiles(params),
      read_skill_file: () => this.readSkillFile(params),
      compose_stack: () => this.composeStack(params),
      inspect_stack: () => this.inspectStack(params),
      diff_stack: () => this.diffStack(params),
      export_selection_evidence: () => this.exportSelectionEvidence(params),
      inspect_selection_evidence: () => this.inspectSelectionEvidence(params),
      tools_list: () => ({ tools: AAS_MCP_TOOLS }),
      initialize: () => ({ protocolVersion: '2024-11-05', capabilities: { tools: {} } })
    };
    const h = handlers[method];
    if (!h) return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    try { return { jsonrpc: '2.0', id, result: h() }; }
    catch (e) { return { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } }; }
  }

  start() {
    import('readline').then(({ createInterface }) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.on('line', line => {
        if (!line.trim()) return;
        try {
          const req = JSON.parse(line);
          const res = this.handleRequest(req.method, req.params, req.id);
          process.stdout.write(JSON.stringify(res) + '\n');
        } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); }
      });
      rl.on('close', () => process.exit(0));
    });
  }
}

export function createAasMcp(catalog) { return new AASCoreMcp({ catalog }); }
