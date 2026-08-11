import { createHash } from "node:crypto";

import type {
  ArtifactDeltaArgs,
  ArtifactDeltaData,
  ArtifactInventoryArgs,
  ArtifactInventoryData,
  ArtifactInventoryItem,
  CommandResult,
  GeneratedArtifact,
  GeneratedFileAffordance,
  RuntimeEnv
} from "../types.js";
import { resultOk } from "../errors.js";
import { contextFromPage } from "./context.js";
import { listLatestArtifacts } from "./artifacts.js";
import { inspectGeneratedFileAffordances } from "./files.js";
import { ensurePage } from "./session.js";
import { localGuardTimeout } from "./timeouts.js";

export async function captureArtifactBaseline(
  env: RuntimeEnv,
  args: ArtifactInventoryArgs = {}
): Promise<CommandResult<ArtifactInventoryData>> {
  const boot = await ensurePage(env);
  if (!boot.ok) return boot as CommandResult<ArtifactInventoryData>;
  const page = env.page!;
  const images = await listLatestArtifacts(env, {
    kind: "image",
    max: args.maxImages ?? 1000,
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs })
  });
  if (!images.ok || images.data === undefined) {
    return forwardFailure(images);
  }

  try {
    const files = await inspectGeneratedFileAffordances(
      page,
      localGuardTimeout(args.timeoutMs, 5000)
    );
    const items = artifactInventoryItems(images.data.artifacts, files);
    const context = await contextFromPage(page);
    return resultOk({ capturedAt: context.timestamp, items }, context, images.warnings);
  } catch (error) {
    return {
      ok: false,
      status: "blocked",
      warnings: images.warnings,
      blocker: {
        kind: "artifact_selector_drift",
        code: "artifact_inventory_failed",
        message: `Artifact inventory could not inspect every visible artifact: ${error instanceof Error ? error.message : String(error)}`,
        resumable: true
      },
      context: await contextFromPage(page)
    };
  }
}

export async function captureArtifactDelta(
  env: RuntimeEnv,
  args: ArtifactDeltaArgs
): Promise<CommandResult<ArtifactDeltaData>> {
  const current = await captureArtifactBaseline(env, args);
  if (!current.ok || current.data === undefined) {
    return forwardFailure(current);
  }
  return resultOk(
    diffArtifactInventories(args.baseline, current.data),
    current.context,
    current.warnings
  );
}

export function diffArtifactInventories(
  baseline: ArtifactInventoryData,
  current: ArtifactInventoryData
): ArtifactDeltaData {
  const remaining = new Map<string, number>();
  for (const item of baseline.items) {
    remaining.set(item.key, (remaining.get(item.key) ?? 0) + 1);
  }
  const added = current.items.filter(item => {
    const count = remaining.get(item.key) ?? 0;
    if (count === 0) return true;
    remaining.set(item.key, count - 1);
    return false;
  });
  return { baseline, current, added };
}

export function artifactInventoryItems(
  images: GeneratedArtifact[],
  files: GeneratedFileAffordance[]
): ArtifactInventoryItem[] {
  return [
    ...images.map(artifact => ({
      key: stableKey({
        kind: "image",
        index: artifact.index,
        turnId: artifact.turnId,
        src: artifact.src,
        width: artifact.width,
        height: artifact.height,
        alt: artifact.alt,
        ariaLabel: artifact.ariaLabel
      }),
      kind: "image" as const,
      artifact
    })),
    ...files.map(file => ({
      key: stableKey({ kind: "file", ...file }),
      kind: "file" as const,
      ...file,
      downloadAvailable: true as const
    }))
  ];
}

function stableKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function forwardFailure<T>(result: CommandResult<unknown>): CommandResult<T> {
  const forwarded: CommandResult<T> = {
    ok: false,
    status: result.status,
    warnings: result.warnings,
    context: result.context
  };
  if (result.output_text !== undefined) forwarded.output_text = result.output_text;
  if (result.reportPath !== undefined) forwarded.reportPath = result.reportPath;
  if (result.error !== undefined) forwarded.error = result.error;
  if (result.blocker !== undefined) forwarded.blocker = result.blocker;
  if (result.steps !== undefined) forwarded.steps = result.steps;
  return forwarded;
}
