import { describe, expect, it, vi } from "vitest";

import {
  collectBridgeOutput,
  type BridgeObservedArtifact,
  type BridgeOutputPort
} from "../../src/bridge/output.js";

function port(overrides: Partial<BridgeOutputPort> = {}): BridgeOutputPort {
  return {
    copyResponseMarkdown: async () => undefined,
    readResponseSnapshot: async () => ({}),
    listArtifacts: async () => [],
    ...overrides
  };
}

describe("bridge output collection", () => {
  it("prefers exact clipboard Markdown", async () => {
    const markdown = "# Result\n\n- keep  two spaces  \n";
    const readResponseSnapshot = vi.fn(async () => ({ text: "DOM", partial: false }));
    await expect(collectBridgeOutput(port({
      copyResponseMarkdown: async () => markdown,
      readResponseSnapshot
    }))).resolves.toEqual({
      markdown,
      fidelity: "clipboard_markdown",
      artifacts: []
    });
    expect(readResponseSnapshot).not.toHaveBeenCalled();
  });

  it("falls back to exact DOM text and preserves partial state", async () => {
    const text = "Partial line\n  indented\n";
    await expect(collectBridgeOutput(port({
      copyResponseMarkdown: async () => { throw new Error("unavailable"); },
      readResponseSnapshot: async () => ({ text, partial: true })
    }))).resolves.toEqual({ text, fidelity: "dom_text", artifacts: [], partial: true });
  });

  it("allows artifact-only responses and deduplicates stable keys", async () => {
    const artifact: BridgeObservedArtifact = {
      key: "a".repeat(64),
      kind: "image",
      name: "result.png"
    };
    const output = await collectBridgeOutput(port({
      listArtifacts: async () => [artifact, artifact]
    }));
    expect(output).toEqual({
      fidelity: "dom_text",
      artifacts: [{
        kind: "image",
        name: "result.png",
        transfer: { status: "not_requested" }
      }]
    });
  });

  it("downloads every adapter-owned artifact only when a destination is supplied", async () => {
    const artifact: BridgeObservedArtifact = {
      key: "b".repeat(64),
      kind: "file",
      name: "report.csv"
    };
    const downloadArtifact = vi.fn(async () => ({
      kind: "file" as const,
      path: "C:/outputs/report.csv",
      bytes: 128,
      sha256: "c".repeat(64)
    }));
    const output = await collectBridgeOutput(port({
      listArtifacts: async () => [artifact],
      downloadArtifact
    }), { downloadDir: "C:/outputs" });

    expect(downloadArtifact).toHaveBeenCalledWith(artifact, "C:/outputs");
    expect(output.artifacts[0]).toMatchObject({
      kind: "file",
      name: "report.csv",
      path: "C:/outputs/report.csv",
      bytes: 128
    });
  });

  it("does not download without an explicit destination", async () => {
    const downloadArtifact = vi.fn();
    await collectBridgeOutput(port({
      listArtifacts: async () => [{ key: "d".repeat(64), kind: "file", name: "report.md" }],
      downloadArtifact
    }));
    expect(downloadArtifact).not.toHaveBeenCalled();
  });

  it("keeps exact response and artifact metadata when download fails", async () => {
    const output = await collectBridgeOutput(port({
      copyResponseMarkdown: async () => "# Still returned\n",
      listArtifacts: async () => [{
        key: "e".repeat(64),
        kind: "file",
        name: "visible.csv"
      }],
      downloadArtifact: async () => { throw new Error("permission denied"); }
    }), { downloadDir: "C:/outputs" });

    expect(output).toEqual({
      markdown: "# Still returned\n",
      fidelity: "clipboard_markdown",
      artifacts: [{
        kind: "file",
        name: "visible.csv",
        transfer: { status: "failed", code: "artifact_transfer_failed" }
      }]
    });
  });

  it("exposes only a stable redacted artifact failure code", async () => {
    const output = await collectBridgeOutput(port({
      listArtifacts: async () => [{
        key: "f".repeat(64),
        kind: "file",
        name: "review.md"
      }],
      downloadArtifact: async () => {
        throw Object.assign(new Error("private path and host details"), {
          code: "artifact_preview_timeout"
        });
      }
    }), { downloadDir: "C:/outputs" });

    expect(output.artifacts).toEqual([{
      kind: "file",
      name: "review.md",
      transfer: { status: "failed", code: "artifact_preview_timeout" }
    }]);
  });
});
