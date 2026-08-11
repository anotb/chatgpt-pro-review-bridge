import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collisionSafeFilename,
  preserveDownloadedArtifact,
  sanitizeArtifactFilename
} from "../../src/reviews/archive.js";
import { parseFindingsAppendix } from "../../src/reviews/findings.js";

describe("review archive helpers", () => {
  it("prevents traversal, reserved characters, and case-insensitive collisions", async () => {
    const archive = await mkdtemp(join(tmpdir(), "chatgpt-pro-review-archive-"));
    const source = join(archive, "source");
    await writeFile(source, "artifact body");
    const used = new Set<string>();

    expect(sanitizeArtifactFilename("../../unsafe:artifact?.csv")).toBe("unsafe_artifact_.csv");
    expect(collisionSafeFilename("Review.csv", used)).toBe("Review.csv");
    expect(collisionSafeFilename("review.csv", used)).toBe("review-2.csv");

    const saved = await preserveDownloadedArtifact(source, archive, "../result.csv", new Set());
    expect(saved.path).toBe(join(archive, "artifacts", "result.csv"));
    expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(saved.path, "utf8")).resolves.toBe("artifact body");
  });

  it("parses a valid appendix while leaving raw Markdown authoritative on parse failure", () => {
    const valid = `# Review\n\nFull prose.\n\n\`\`\`json\n[{"severity":"high","confidence":0.9,"file":"src/a.ts","startLine":1,"endLine":2,"category":"correctness","title":"Bug","evidence":"e","failureScenario":"f","recommendedFix":"x","regressionTest":"t"}]\n\`\`\``;
    expect(parseFindingsAppendix(valid)).toEqual([expect.objectContaining({ severity: "high", title: "Bug" })]);
    expect(parseFindingsAppendix("# Review\n\n```json\nnot-json\n```")) .toBeUndefined();
  });
});
