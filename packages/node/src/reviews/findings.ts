import type { ParsedFinding } from "./types.js";

export function parseFindingsAppendix(markdown: string): ParsedFinding[] | undefined {
  const fences = Array.from(markdown.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).reverse();
  for (const fence of fences) {
    const body = fence[1]?.trim();
    if (body === undefined || body.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      continue;
    }
    const candidates = Array.isArray(value)
      ? value
      : typeof value === "object" && value !== null && Array.isArray((value as { findings?: unknown }).findings)
        ? (value as { findings: unknown[] }).findings
        : undefined;
    if (candidates === undefined) continue;
    const findings = candidates.map(parseFinding).filter((item): item is ParsedFinding => item !== undefined);
    if (findings.length === candidates.length) return findings;
  }
  return undefined;
}

function parseFinding(value: unknown): ParsedFinding | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Record<string, unknown>;
  const severity = item.severity;
  if (!isSeverity(severity)) return undefined;
  const required = ["file", "category", "title", "evidence", "failureScenario", "recommendedFix", "regressionTest"] as const;
  if (!required.every(key => typeof item[key] === "string")) return undefined;
  if (typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1) return undefined;
  if (!Number.isInteger(item.startLine) || !Number.isInteger(item.endLine)) return undefined;
  return {
    severity,
    confidence: item.confidence,
    file: item.file as string,
    startLine: item.startLine as number,
    endLine: item.endLine as number,
    category: item.category as string,
    title: item.title as string,
    evidence: item.evidence as string,
    failureScenario: item.failureScenario as string,
    recommendedFix: item.recommendedFix as string,
    regressionTest: item.regressionTest as string
  };
}

function isSeverity(value: unknown): value is ParsedFinding["severity"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}
