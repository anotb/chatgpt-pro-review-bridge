import type {
  BridgeSelection,
  BridgeTargetOption,
  BridgeTargetSnapshot
} from "./types.js";

export type BridgeTargetPort = {
  inspectTargets(): Promise<BridgeTargetSnapshot>;
  selectTarget(axis: string, label: string): Promise<void>;
};

export type BridgeTargetSelectionErrorCode =
  | "target_axis_unavailable"
  | "target_value_unavailable"
  | "target_value_ambiguous"
  | "target_value_disabled"
  | "target_unverified";

export class BridgeTargetSelectionError extends Error {
  readonly code: BridgeTargetSelectionErrorCode;
  readonly axis: string;
  readonly value: string;

  constructor(
    code: BridgeTargetSelectionErrorCode,
    axis: string,
    value: string,
    message: string
  ) {
    super(message);
    this.name = "BridgeTargetSelectionError";
    this.code = code;
    this.axis = axis;
    this.value = value;
  }
}

type PlannedSelection = {
  axis: keyof BridgeSelection;
  value: string;
  option: BridgeTargetOption;
};

/**
 * Select open-ended visible ChatGPT targets without owning a model or mode
 * registry. Every requested axis is validated before the first UI mutation,
 * and the resulting state is inspected once after all mutations.
 */
export async function selectTargets(
  port: BridgeTargetPort,
  requested: BridgeSelection
): Promise<BridgeTargetSnapshot> {
  const before = await port.inspectTargets();
  const plan = (Object.entries(requested) as Array<[keyof BridgeSelection, string]>).map(([axis, value]) =>
    planSelection(before, axis, value)
  );

  if (plan.length === 0) {
    return before;
  }

  let changed = false;
  for (const item of plan) {
    const alreadySelected =
      before.active[item.axis] === item.value && item.option.selected;
    if (!alreadySelected) {
      await port.selectTarget(item.axis, item.value);
      changed = true;
    }
  }

  if (!changed) return before;

  const after = await port.inspectTargets();
  verifyTargets(after, requested);
  return after;
}

export function verifyTargets(
  snapshot: BridgeTargetSnapshot,
  requested: BridgeSelection
): void {
  for (const [axis, value] of Object.entries(requested) as Array<[keyof BridgeSelection, string]>) {
    verifySelection(snapshot, axis, value);
  }
}

function planSelection(
  snapshot: BridgeTargetSnapshot,
  axis: keyof BridgeSelection,
  value: string
): PlannedSelection {
  const options = snapshot.options[axis];
  if (options === undefined) {
    throw new BridgeTargetSelectionError(
      "target_axis_unavailable",
      axis,
      value,
      `Target axis ${JSON.stringify(axis)} is not visible.`
    );
  }

  const matches = options.filter((option) => option.label === value);
  if (matches.length === 0) {
    throw new BridgeTargetSelectionError(
      "target_value_unavailable",
      axis,
      value,
      `Target ${JSON.stringify(value)} is not visible on axis ${JSON.stringify(axis)}.`
    );
  }
  if (matches.length !== 1) {
    throw new BridgeTargetSelectionError(
      "target_value_ambiguous",
      axis,
      value,
      `Target ${JSON.stringify(value)} is ambiguous on axis ${JSON.stringify(axis)}.`
    );
  }

  const option = matches[0]!;
  if (option.disabled === true) {
    throw new BridgeTargetSelectionError(
      "target_value_disabled",
      axis,
      value,
      `Target ${JSON.stringify(value)} is disabled on axis ${JSON.stringify(axis)}.`
    );
  }

  return { axis, value, option };
}

function verifySelection(
  snapshot: BridgeTargetSnapshot,
  axis: keyof BridgeSelection,
  value: string
): void {
  const matches = snapshot.options[axis]?.filter(
    (option) => option.label === value
  );
  const verified =
    matches?.length === 1 &&
    matches[0]?.disabled !== true &&
    matches[0]?.selected === true &&
    snapshot.active[axis] === value;

  if (!verified) {
    throw new BridgeTargetSelectionError(
      "target_unverified",
      axis,
      value,
      `Target ${JSON.stringify(value)} was not verified on axis ${JSON.stringify(axis)}.`
    );
  }
}
