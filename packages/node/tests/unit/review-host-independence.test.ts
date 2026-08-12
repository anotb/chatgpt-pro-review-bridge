import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("review runtime host independence", () => {
  it("does not branch on named Codex host models in runtime source", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "reviews");
    const files = ["types.ts", "packet-builder.ts", "archive.ts", "code-review.ts"];
    const source = (await Promise.all(files.map(file => readFile(join(root, file), "utf8")))).join("\n");

    expect(source).not.toMatch(/\b(?:Sol|Terra|Luna)\b/);
  });
});
