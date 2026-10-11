export function createTrustApprovalWrapper({
  checkTrust,
  baseApprove,
  resolveTrust,
  ctx,
  pause,
  resume,
} = {}) {
  return async (name, args, detail) => {
    // Trust is read LIVE from ctx each call: `/trust` mutates ctx.trustLevel
    // mid-session, and a closed-over startup value would silently ignore it.
    if (typeof checkTrust === 'function') {
      const verdict = checkTrust({ name, args, trustLevel: resolveTrust(), ctx });
      if (verdict?.allowed === true) {
        return true; // auto-allow (yolo, trusted, read-only, project-local balanced)
      }
      if (verdict && verdict.allowed === false && verdict.requiresApproval !== true) {
        return false; // hard deny (destructive, paranoid, external under balanced)
      }
      // requiresApproval true (or unset) -> fall through to interactive prompt
    }
    pause();
    try { return await baseApprove(name, args, detail); } finally { resume(); }
  };
};
