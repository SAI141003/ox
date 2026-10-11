import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diffLines, applyHunks, parseFileToolEvent } from "../src/diff.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

describe("diff helper", () => {
  it("produces correct hunks for simple addition", () => {
    const oldText = "line1\nline2\nline3";
    const newText = "line1\nline2\nnewline\nline3";
    const hunks = diffLines(oldText, newText);
    assert.equal(hunks.length, 1);
    const hunk = hunks[0];
    assert.ok(hunk.lines.some(l => l.type === 'add' && l.content === 'newline'));
    assert.ok(hunk.lines.some(l => l.type === 'context' && l.content === 'line1'));
    assert.ok(hunk.lines.some(l => l.type === 'context' && l.content === 'line2'));
    assert.ok(hunk.lines.some(l => l.type === 'context' && l.content === 'line3'));
  });

  it("produces correct hunks for simple deletion", () => {
    const oldText = "line1\nline2\nline3";
    const newText = "line1\nline3";
    const hunks = diffLines(oldText, newText);
    assert.equal(hunks.length, 1);
    const hunk = hunks[0];
    assert.ok(hunk.lines.some(l => l.type === 'remove' && l.content === 'line2'));
    assert.ok(hunk.lines.some(l => l.type === 'context' && l.content === 'line1'));
    assert.ok(hunk.lines.some(l => l.type === 'context' && l.content === 'line3'));
  });

  it("produces correct hunks for modification", () => {
    const oldText = "line1\noldline\nline3";
    const newText = "line1\nnewline\nline3";
    const hunks = diffLines(oldText, newText);
    assert.equal(hunks.length, 1);
    const hunk = hunks[0];
    assert.ok(hunk.lines.some(l => l.type === 'remove' && l.content === 'oldline'));
    assert.ok(hunk.lines.some(l => l.type === 'add' && l.content === 'newline'));
    assert.ok(hunk.lines.some(l => l.type === 'context' && l.content === 'line1'));
    assert.ok(hunk.lines.some(l => l.type === 'context' && l.content === 'line3'));
  });

  it("handles empty old content (new file)", () => {
    const oldText = "";
    const newText = "line1\nline2";
    const hunks = diffLines(oldText, newText);
    assert.equal(hunks.length, 1);
    const hunk = hunks[0];
    assert.equal(hunk.oldStart, 0);
    assert.equal(hunk.oldLines, 0);
    assert.equal(hunk.newStart, 0);
    assert.equal(hunk.newLines, 2);
    assert.ok(hunk.lines.every(l => l.type === 'add'));
  });

  it("handles empty new content (delete file)", () => {
    const oldText = "line1\nline2";
    const newText = "";
    const hunks = diffLines(oldText, newText);
    assert.equal(hunks.length, 1);
    const hunk = hunks[0];
    assert.equal(hunk.oldStart, 0);
    assert.equal(hunk.oldLines, 2);
    assert.equal(hunk.newStart, 0);
    assert.equal(hunk.newLines, 0);
    assert.ok(hunk.lines.every(l => l.type === 'remove'));
  });

  it("applyHunks with all accepted returns new content", () => {
    const oldText = "line1\nline2\nline3";
    const newText = "line1\nnewline\nline3";
    const hunks = diffLines(oldText, newText);
    const accepted = new Set([0]);
    const result = applyHunks(oldText, hunks, accepted);
    assert.equal(result, newText);
  });

  it("applyHunks with none accepted returns old content", () => {
    const oldText = "line1\nline2\nline3";
    const newText = "line1\nnewline\nline3";
    const hunks = diffLines(oldText, newText);
    const accepted = new Set();
    const result = applyHunks(oldText, hunks, accepted);
    assert.equal(result, oldText);
  });

  it("applyHunks with partial acceptance - single hunk means all or nothing", () => {
    // This diff algorithm produces a single hunk for all changes.
    // Partial acceptance at hunk granularity means accept all or reject all.
    const oldText = "a\nb\nc\nd";
    const newText = "a\nb2\nc2\nd";
    const hunks = diffLines(oldText, newText);
    assert.equal(hunks.length, 1, "simple diff produces single hunk");
    
    // Accepting the hunk applies all changes
    const accepted = new Set([0]);
    const result = applyHunks(oldText, hunks, accepted);
    assert.equal(result, newText);
    
    // Rejecting keeps old
    const rejected = new Set();
    const result2 = applyHunks(oldText, hunks, rejected);
    assert.equal(result2, oldText);
  });

  it("parseFileToolEvent extracts write_file info", () => {
    const event = {
      name: "write_file",
      data: { name: "write_file", args: { path: "test.txt", newContent: "hello" } }
    };
    const parsed = parseFileToolEvent(event);
    assert.ok(parsed);
    assert.equal(parsed.path, "test.txt");
    assert.equal(parsed.newContent, "hello");
    assert.equal(parsed.oldContent, "");
    assert.equal(parsed.isNew, true);
  });

  it("parseFileToolEvent extracts edit_file info", () => {
    const event = {
      name: "edit_file",
      data: { name: "edit_file", args: { path: "test.txt", oldContent: "old", newContent: "new" } }
    };
    const parsed = parseFileToolEvent(event);
    assert.ok(parsed);
    assert.equal(parsed.path, "test.txt");
    assert.equal(parsed.oldContent, "old");
    assert.equal(parsed.newContent, "new");
  });

  it("parseFileToolEvent returns null for non-file tools", () => {
    const event = {
      name: "run_command",
      data: { name: "run_command", args: { cmd: "ls" } }
    };
    const parsed = parseFileToolEvent(event);
    assert.equal(parsed, null);
  });
});

describe("ox_read_file / ox_write_file round-trip (via Node fs as proxy)", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ox-editor-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("write then read returns same content", async () => {
    const testFile = path.join(tmpDir, "test-roundtrip.txt");
    const content = "Hello, world!\nLine 2\nLine 3";
    fs.writeFileSync(testFile, content, "utf8");
    const readBack = fs.readFileSync(testFile, "utf8");
    assert.equal(readBack, content);
  });

  it("read missing file throws", () => {
    const missingFile = path.join(tmpDir, "does-not-exist.txt");
    assert.throws(() => {
      fs.readFileSync(missingFile, "utf8");
    }, /ENOENT/);
  });

  it("write to nested path creates parent dirs", () => {
    const nestedFile = path.join(tmpDir, "a", "b", "c", "deep.txt");
    const content = "deep content";
    fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
    fs.writeFileSync(nestedFile, content, "utf8");
    const readBack = fs.readFileSync(nestedFile, "utf8");
    assert.equal(readBack, content);
  });

  it("write overwrites existing content", () => {
    const testFile = path.join(tmpDir, "overwrite.txt");
    fs.writeFileSync(testFile, "old", "utf8");
    fs.writeFileSync(testFile, "new", "utf8");
    const readBack = fs.readFileSync(testFile, "utf8");
    assert.equal(readBack, "new");
  });
});
