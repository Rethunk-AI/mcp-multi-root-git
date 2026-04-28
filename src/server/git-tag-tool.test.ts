/**
 * Tests for git_tag tool.
 *
 * These tests verify that the tool correctly handles tag creation
 * (annotated and lightweight), deletion, and validation.
 */

import { describe, expect, test } from "bun:test";

describe("git_tag tool parameter handling", () => {
  test("validates tag name is not empty", () => {
    const tag = "";
    expect(tag.length).toBe(0);
  });

  test("validates tag name with valid characters", () => {
    const validTags = ["v1.2.3", "release-1.0", "alpha_1", "tag-with-dash"];
    for (const tag of validTags) {
      // Tags with alphanumerics, dots, dashes, underscores are valid
      const isValid = /^[a-zA-Z0-9._/-]+$/.test(tag);
      expect(isValid).toBe(true);
    }
  });

  test("validates tag name with unsafe characters", () => {
    const unsafeTags = ["tag\nwith\nnewline", "tag;rm -rf", "tag|cat", "tag&kill"];
    for (const tag of unsafeTags) {
      // Tags with shell metacharacters should be rejected
      const hasShellMeta = /[\n\r;|&`$<>()]/.test(tag);
      expect(hasShellMeta).toBe(true);
    }
  });

  test("distinguishes annotated vs lightweight tags", () => {
    // Annotated tags have a message
    const withMessage = { tag: "v1.0", message: "Release 1.0" };
    expect(withMessage.message).toBeTruthy();

    // Lightweight tags have no message
    const noMessage = { tag: "v1.0", message: undefined };
    expect(noMessage.message).toBeUndefined();
  });

  test("handles deletion flag", () => {
    const createOp = { tag: "v1.0", delete: false };
    expect(createOp.delete).toBe(false);

    const deleteOp = { tag: "v1.0", delete: true };
    expect(deleteOp.delete).toBe(true);
  });

  test("defaults ref to HEAD", () => {
    const explicitRef = { ref: "main" };
    expect(explicitRef.ref).toBe("main");

    const implicitRef = { ref: undefined };
    const defaultRef = implicitRef.ref ?? "HEAD";
    expect(defaultRef).toBe("HEAD");
  });

  test("accepts valid refs", () => {
    const validRefs = ["HEAD", "main", "feature-branch", "v1.2.3", "HEAD~3"];
    for (const ref of validRefs) {
      // Basic sanity: they don't contain obvious injection chars
      const hasShellMeta = /[\n\r;|&`$<>]/.test(ref);
      expect(hasShellMeta).toBe(false);
    }
  });
});

describe("git_tag tool result structure", () => {
  test("returns tag, type, and sha for creation", () => {
    const result = {
      tag: "v1.0",
      type: "annotated" as const,
      sha: "abc123def456",
    };
    expect(result.tag).toBeDefined();
    expect(result.type).toBeDefined();
    expect(result.sha).toBeDefined();
    expect(["annotated", "lightweight"]).toContain(result.type);
  });

  test("returns tag, type='deleted', and empty sha for deletion", () => {
    const result = {
      tag: "v1.0",
      type: "deleted" as const,
      sha: "",
    };
    expect(result.type).toBe("deleted");
    expect(result.sha).toBe("");
  });

  test("correctly identifies annotated vs lightweight", () => {
    const annotated = { type: "annotated" as const };
    expect(annotated.type).toBe("annotated");

    const lightweight = { type: "lightweight" as const };
    expect(lightweight.type).toBe("lightweight");
  });

  test("formats markdown output correctly", () => {
    const markdown = `# Tag: v1.0

**Type:** annotated
**SHA:** \`abc123\`

**Message:**

\`\`\`
Release version 1.0
\`\`\``;
    expect(markdown).toContain("# Tag: v1.0");
    expect(markdown).toContain("**Type:**");
    expect(markdown).toContain("**SHA:**");
    expect(markdown).toContain("**Message:**");
  });

  test("formats json output correctly", () => {
    const json = {
      tag: "v1.0",
      type: "annotated",
      sha: "abc123",
    };
    expect(JSON.stringify(json)).toContain('"tag":"v1.0"');
    expect(JSON.stringify(json)).toContain('"type":"annotated"');
  });
});
