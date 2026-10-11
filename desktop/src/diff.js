/**
 * Tiny pure-JS line-based diff helper (no deps).
 * Simple approach: find first/last differing lines, produce single hunk.
 * Good enough for editor diff/apply use case.
 */

function splitLines(text) {
  if (text === '') return [];
  return text.split('\n');
}

function findCommonPrefix(oldLines, newLines) {
  let i = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (i < minLen && oldLines[i] === newLines[i]) {
    i++;
  }
  return i;
}

function findCommonSuffix(oldLines, newLines, prefixLen) {
  let i = 0;
  const maxSuffix = Math.min(oldLines.length - prefixLen, newLines.length - prefixLen);
  while (i < maxSuffix && oldLines[oldLines.length - 1 - i] === newLines[newLines.length - 1 - i]) {
    i++;
  }
  return i;
}

export function diffLines(oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  
  const prefixLen = findCommonPrefix(oldLines, newLines);
  const suffixLen = findCommonSuffix(oldLines, newLines, prefixLen);
  
  const oldMiddle = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newMiddle = newLines.slice(prefixLen, newLines.length - suffixLen);
  
  // If no changes, return empty hunks
  if (oldMiddle.length === 0 && newMiddle.length === 0) {
    return [];
  }
  
  // Build single hunk with context
  const contextLines = 3;
  const contextStart = Math.max(0, prefixLen - contextLines);
  const contextEndOld = Math.min(oldLines.length, oldLines.length - suffixLen + contextLines);
  const contextEndNew = Math.min(newLines.length, newLines.length - suffixLen + contextLines);
  
  const hunkLines = [];
  
  // Add context before
  for (let k = contextStart; k < prefixLen; k++) {
    hunkLines.push({ type: 'context', content: oldLines[k] });
  }
  
  // Add removed lines
  for (const line of oldMiddle) {
    hunkLines.push({ type: 'remove', content: line });
  }
  
  // Add added lines
  for (const line of newMiddle) {
    hunkLines.push({ type: 'add', content: line });
  }
  
  // Add context after
  for (let k = oldLines.length - suffixLen; k < contextEndOld; k++) {
    hunkLines.push({ type: 'context', content: oldLines[k] });
  }
  
  return [{
    oldStart: contextStart,
    oldLines: contextEndOld - contextStart,
    newStart: contextStart,
    newLines: contextEndNew - contextStart,
    lines: hunkLines,
  }];
}

/**
 * Apply accepted hunks to produce new content.
 * `accepted` is a Set of hunk indices to apply.
 */
export function applyHunks(oldText, hunks, accepted) {
  const oldLines = splitLines(oldText);
  let result = [];
  let oldIdx = 0;
  
  for (let hunkIdx = 0; hunkIdx < hunks.length; hunkIdx++) {
    const hunk = hunks[hunkIdx];
    const accept = accepted.has(hunkIdx);
    
    // Add unchanged lines before this hunk
    while (oldIdx < hunk.oldStart) {
      result.push(oldLines[oldIdx]);
      oldIdx++;
    }
    
    if (accept) {
      // Add new content from hunk (only add and context lines)
      for (const line of hunk.lines) {
        if (line.type !== 'remove') {
          result.push(line.content);
        }
      }
    } else {
      // Keep old content (only remove and context lines)
      for (const line of hunk.lines) {
        if (line.type !== 'add') {
          result.push(line.content);
        }
      }
    }
    
    oldIdx = hunk.oldStart + hunk.oldLines;
  }
  
  // Add remaining lines
  while (oldIdx < oldLines.length) {
    result.push(oldLines[oldIdx]);
    oldIdx++;
  }
  
  return result.join('\n');
}

/**
 * Parse tool-end event for write_file/edit_file to extract diff info.
 * Expected event shape from agent:
 *   - write_file: { newContent, path }
 *   - edit_file: { oldContent, newContent, path } or { diff, path }
 */
export function parseFileToolEvent(event) {
  if (!event || !event.data) return null;
  const data = event.data;
  const name = data.name || event.name;
  
  if (name === 'write_file') {
    return {
      path: data.args?.path,
      oldContent: '',
      newContent: data.args?.newContent ?? data.args?.content ?? '',
      isNew: true,
    };
  }
  
  if (name === 'edit_file') {
    const args = data.args || {};
    if (args.diff) {
      return {
        path: args.path,
        diff: args.diff,
        oldContent: args.oldContent ?? '',
        newContent: args.newContent ?? '',
      };
    }
    return {
      path: args.path,
      oldContent: args.oldContent ?? '',
      newContent: args.newContent ?? '',
    };
  }
  
  return null;
}
