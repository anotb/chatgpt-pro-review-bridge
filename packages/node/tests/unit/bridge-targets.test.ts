import { describe, expect, it } from "vitest";
import {
  BridgeTargetSelectionError,
  selectTargets,
  type BridgeTargetPort
} from "../../src/bridge/targets.js";
import type { BridgeSelection, BridgeTargetSnapshot } from "../../src/bridge/types.js";

describe("bridge target selection", () => {
  it("selects an arbitrary exact dynamic Power label and inspects once afterward", async () => {
    const before = snapshot(
      { power: "Instant" },
      { power: [option("Instant", true), option("Future Research Preview")] }
    );
    const after = snapshot(
      { power: "Future Research Preview" },
      { power: [option("Instant"), option("Future Research Preview", true)] }
    );
    const port = fakePort(before, after);

    const result = await selectTargets(port, { power: "Future Research Preview" });

    expect(result).toBe(after);
    expect(port.inspections()).toBe(2);
    expect(port.selections).toEqual([["power", "Future Research Preview"]]);
  });

  it("preflights every requested axis before changing the UI", async () => {
    const port = fakePort(
      snapshot(
        { power: "Instant" },
        { power: [option("Instant", true), option("Pro")] }
      )
    );

    await expect(
      selectTargets(port, {
        power: "Pro",
        nonexistent: "Anything"
      } as unknown as BridgeSelection)
    ).rejects.toMatchObject({
      code: "target_axis_unavailable",
      axis: "nonexistent",
      value: "Anything"
    });
    expect(port.selections).toEqual([]);
    expect(port.inspections()).toBe(1);
  });

  it("requires literal labels rather than aliases or case folding", async () => {
    const port = fakePort(
      snapshot({ power: "Instant" }, { power: [option("Instant", true), option("PRO")] })
    );

    await expect(selectTargets(port, { power: "Pro" })).rejects.toMatchObject({
      code: "target_value_unavailable",
      axis: "power",
      value: "Pro"
    });
    expect(port.selections).toEqual([]);
  });

  it("rejects duplicate exact labels as ambiguous", async () => {
    const port = fakePort(
      snapshot(
        {},
        { power: [option("Pro"), option("Pro", false, true)] }
      )
    );

    await expect(selectTargets(port, { power: "Pro" })).rejects.toMatchObject({
      code: "target_value_ambiguous"
    });
    expect(port.selections).toEqual([]);
  });

  it("rejects a uniquely visible disabled option", async () => {
    const port = fakePort(
      snapshot({}, { power: [option("Deep research", false, true)] })
    );

    await expect(
      selectTargets(port, { power: "Deep research" })
    ).rejects.toMatchObject({ code: "target_value_disabled" });
    expect(port.selections).toEqual([]);
  });

  it("skips a target already verified as selected", async () => {
    const selected = snapshot(
      { power: "Pro" },
      { power: [option("Instant"), option("Pro", true)] }
    );
    const port = fakePort(selected, selected);

    await expect(selectTargets(port, { power: "Pro" })).resolves.toBe(selected);
    expect(port.selections).toEqual([]);
    expect(port.inspections()).toBe(1);
  });

  it("fails closed when the post-selection inspection cannot verify the target", async () => {
    const port = fakePort(
      snapshot(
        { power: "Instant" },
        { power: [option("Instant", true), option("Pro")] }
      ),
      snapshot(
        { power: "Pro" },
        { power: [option("Instant"), option("Pro")] }
      )
    );

    await expect(selectTargets(port, { power: "Pro" })).rejects.toEqual(
      expect.objectContaining<Partial<BridgeTargetSelectionError>>({
        code: "target_unverified",
        axis: "power",
        value: "Pro"
      })
    );
    expect(port.selections).toEqual([["power", "Pro"]]);
    expect(port.inspections()).toBe(2);
  });
});

function option(
  label: string,
  selected = false,
  disabled?: boolean
): { label: string; selected: boolean; disabled?: boolean } {
  return disabled === undefined
    ? { label, selected }
    : { label, selected, disabled };
}

function snapshot(
  active: BridgeTargetSnapshot["active"],
  options: BridgeTargetSnapshot["options"]
): BridgeTargetSnapshot {
  return { active, options };
}

function fakePort(...snapshots: BridgeTargetSnapshot[]): BridgeTargetPort & {
  selections: Array<[string, string]>;
  inspections(): number;
} {
  let inspectionCount = 0;
  const selections: Array<[string, string]> = [];

  return {
    selections,
    inspections: () => inspectionCount,
    async inspectTargets() {
      const current = snapshots[inspectionCount];
      inspectionCount += 1;
      if (current === undefined) {
        throw new Error("Unexpected target inspection");
      }
      return current;
    },
    async selectTarget(axis, label) {
      selections.push([axis, label]);
    }
  };
}
