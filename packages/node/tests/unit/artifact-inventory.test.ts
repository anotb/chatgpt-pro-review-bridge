import { describe, expect, it } from "vitest";

import {
  artifactInventoryItems,
  diffArtifactInventories
} from "../../src/commands/artifact-inventory.js";
import type { ArtifactInventoryData, GeneratedArtifact } from "../../src/types.js";

const oldImage: GeneratedArtifact = {
  kind: "image",
  index: 0,
  visible: true,
  turnId: "conversation-turn-2",
  alt: "older image",
  downloadAvailable: true,
  selectorProvenance: "fixture"
};

describe("artifact inventory baselines", () => {
  it("returns only artifacts added after the baseline", () => {
    const baseline: ArtifactInventoryData = {
      capturedAt: "2026-08-11T00:00:00.000Z",
      items: artifactInventoryItems([oldImage], [
        { assistantIndex: 0, filename: "older.csv", tag: "button" }
      ])
    };
    const newImage: GeneratedArtifact = {
      ...oldImage,
      index: 1,
      turnId: "conversation-turn-4",
      alt: "new image"
    };
    const current: ArtifactInventoryData = {
      capturedAt: "2026-08-11T00:01:00.000Z",
      items: artifactInventoryItems([oldImage, newImage], [
        { assistantIndex: 0, filename: "older.csv", tag: "button" },
        { assistantIndex: 1, filename: "review.md", tag: "button" },
        { assistantIndex: 1, filename: "findings.csv", tag: "a" }
      ])
    };

    const delta = diffArtifactInventories(baseline, current);

    expect(delta.added.map(item => item.kind)).toEqual(["image", "file", "file"]);
    expect(delta.added.filter(item => item.kind === "file").map(item => item.filename)).toEqual([
      "review.md",
      "findings.csv"
    ]);
  });

  it("uses stable keys and preserves duplicate occurrence counts", () => {
    const file = { assistantIndex: 1, filename: "same.csv", tag: "button" as const };
    const item = artifactInventoryItems([], [file])[0]!;
    const baseline = { capturedAt: "before", items: [item] };
    const current = { capturedAt: "after", items: [item, { ...item }] };

    expect(diffArtifactInventories(baseline, current).added).toEqual([{ ...item }]);
    expect(artifactInventoryItems([], [file])[0]?.key).toBe(item.key);
  });
});
