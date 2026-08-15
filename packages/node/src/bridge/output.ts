import type {
  BridgeArtifact,
  BridgeArtifactTransferFailureCode,
  BridgeOutput
} from "./types.js";

/**
 * A response snapshot derived from the visible assistant turn.
 *
 * The adapter owns DOM access. Keeping the snapshot this small prevents the
 * bridge core from accumulating selectors or an HTML parser.
 */
export type BridgeResponseSnapshot = {
  text?: string;
  partial?: boolean;
};

/**
 * An artifact visible in the thread. `key` must be stable across repeated
 * inventory reads and distinct for separate artifacts with the same name.
 */
export type BridgeObservedArtifact = BridgeArtifact & {
  key: string;
};

/**
 * The browser-facing boundary required to collect one assistant output.
 *
 * `copyResponseMarkdown` owns any clipboard snapshot/restore necessary to use
 * ChatGPT's visible Copy action. This module never reads, writes, or persists
 * the user's clipboard itself.
 */
export type BridgeOutputPort = {
  copyResponseMarkdown(): Promise<string | undefined>;
  readResponseSnapshot(): Promise<BridgeResponseSnapshot>;
  listArtifacts(): Promise<readonly BridgeObservedArtifact[]>;
  downloadArtifact?(
    artifact: BridgeObservedArtifact,
    downloadDir: string
  ): Promise<BridgeArtifact>;
};

export type CollectBridgeOutputOptions = {
  downloadDir?: string;
};

/**
 * Collect the latest assistant response and artifacts attributed to this run.
 * Exact clipboard Markdown wins; visible DOM text is the fidelity-labelled
 * fallback. Artifact-only responses are valid outputs.
 */
export async function collectBridgeOutput(
  port: BridgeOutputPort,
  options: CollectBridgeOutputOptions = {}
): Promise<BridgeOutput> {
  // A failed or unavailable Copy action is expected to fall back to DOM text.
  // Clipboard interaction, including safe restore, remains entirely in port.
  const markdown = await port.copyResponseMarkdown().catch(() => undefined);
  const [response, inventory] = await Promise.all([
    markdown === undefined ? port.readResponseSnapshot() : undefined,
    port.listArtifacts()
  ]);
  const artifacts = await collectArtifacts(port, uniqueArtifacts(inventory), options.downloadDir);

  const output: BridgeOutput = markdown !== undefined
    ? { markdown, fidelity: "clipboard_markdown", artifacts }
    : {
        ...(response?.text === undefined ? {} : { text: response.text }),
        fidelity: "dom_text",
        artifacts
      };

  if (response?.partial !== undefined) output.partial = response.partial;
  return output;
}

async function collectArtifacts(
  port: BridgeOutputPort,
  artifacts: readonly BridgeObservedArtifact[],
  downloadDir: string | undefined
): Promise<BridgeArtifact[]> {
  const collected: BridgeArtifact[] = [];

  for (const observed of artifacts) {
    const metadata = withoutKey(observed);
    if (downloadDir === undefined || port.downloadArtifact === undefined) {
      collected.push({ ...metadata, transfer: { status: "not_requested" } });
      continue;
    }

    try {
      const downloaded = await port.downloadArtifact(observed, downloadDir);
      collected.push({ ...metadata, ...downloaded, transfer: { status: "downloaded" } });
    } catch (error) {
      // A failed exact download must not hide the already-owned response or
      // the fact that the artifact exists. Only a stable redacted code crosses
      // the output boundary; raw host errors and local paths remain private.
      collected.push({
        ...metadata,
        transfer: { status: "failed", code: artifactTransferFailureCode(error) }
      });
    }
  }

  return collected;
}

function uniqueArtifacts(
  artifacts: readonly BridgeObservedArtifact[]
): BridgeObservedArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter(artifact => {
    if (seen.has(artifact.key)) return false;
    seen.add(artifact.key);
    return true;
  });
}

function withoutKey(artifact: BridgeObservedArtifact): BridgeArtifact {
  const { key: _key, ...metadata } = artifact;
  return metadata;
}

function artifactTransferFailureCode(error: unknown): BridgeArtifactTransferFailureCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "artifact_preview_timeout" || code === "artifact_download_unavailable"
    ? code
    : "artifact_transfer_failed";
}
