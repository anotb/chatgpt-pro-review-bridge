import { describe, expect, it } from "vitest";
import {
  BrowserPowerTargetError,
  ChatGPTPowerTargetPort
} from "../../src/bridge/browser-targets.js";
import type { BrowserLocator, BrowserPage } from "../../src/bridge/browser-runtime.js";

const LABELS = ["Faster", "Balanced", "High", "Extra High", "Pro"];

describe("visible Chat Power targets", () => {
  it("enumerates announcement labels, excludes helper text, and restores inspection", async () => {
    const page = powerPage(LABELS, 2);
    const port = new ChatGPTPowerTargetPort(page);

    const inspected = await port.inspectTargets();
    const scanKeys = page.keys().length;
    const repeated = await port.inspectTargets();

    expect(inspected).toEqual({
      active: { power: "High" },
      options: {
        power: LABELS.map((label) => ({ label, selected: label === "High" }))
      }
    });
    expect(inspected.options.power?.map((option) => option.label)).not.toContain(
      "Choose how much reasoning ChatGPT should use."
    );
    expect(page.current()).toBe(2);
    expect(page.keys()).toHaveLength(scanKeys);
    expect(repeated).toEqual(inspected);
  });

  it("moves exactly to dynamically discovered Faster and Pro labels", async () => {
    const page = powerPage(LABELS, 2);
    const port = new ChatGPTPowerTargetPort(page);

    await port.selectTarget("power", "Faster");
    expect(page.current()).toBe(0);

    await port.selectTarget("power", "Pro");
    expect(page.current()).toBe(4);
  });

  it("uses the visible ARIA range instead of assuming five positions", async () => {
    const labels = ["Quick", "Deliberate", "Pro"];
    const page = powerPage(labels, 1);
    const port = new ChatGPTPowerTargetPort(page);

    await expect(port.inspectTargets()).resolves.toMatchObject({
      active: { power: "Deliberate" },
      options: { power: labels.map(label => ({ label })) }
    });
    await port.selectTarget("power", "Pro");
    expect(page.current()).toBe(2);
  });

  it("restores the original setting when a requested label is unavailable", async () => {
    const page = powerPage(LABELS, 3);
    const port = new ChatGPTPowerTargetPort(page);

    await expect(port.selectTarget("power", "Turbo")).rejects.toMatchObject({
      code: "power_target_unavailable"
    });
    expect(page.current()).toBe(3);
  });

  it("restores the original setting when announcement reading fails mid-inspection", async () => {
    const page = powerPage(["", ...LABELS.slice(1)], 2);
    const port = new ChatGPTPowerTargetPort(page);

    await expect(port.inspectTargets()).rejects.toMatchObject({
      code: "power_invalid"
    });
    expect(page.current()).toBe(2);
  });

  it("fails closed on duplicate announced labels and restores the setting", async () => {
    const page = powerPage(["Faster", "Balanced", "High", "Pro", "Pro"], 2);
    const port = new ChatGPTPowerTargetPort(page);

    await expect(port.inspectTargets()).rejects.toEqual(
      expect.objectContaining<Partial<BrowserPowerTargetError>>({
        code: "power_ambiguous"
      })
    );
    expect(page.current()).toBe(2);
  });

  it("fails closed when more than one Power slider is visible", async () => {
    const page = powerPage(LABELS, 2, { sliderCount: 2 });
    const port = new ChatGPTPowerTargetPort(page);

    await expect(port.inspectTargets()).rejects.toMatchObject({
      code: "power_ambiguous"
    });
    expect(page.keys()).toEqual([]);
  });
});

type FakePowerPage = BrowserPage & {
  current(): number;
  keys(): string[];
};

function powerPage(
  labels: string[],
  initial: number,
  options: { sliderCount?: number } = {}
): FakePowerPage {
  let current = initial;
  const keys: string[] = [];
  const describedNode = (
    text: string,
    attributes: Record<string, string> = {}
  ) => ({
    innerText: text,
    textContent: text,
    getAttribute: (name: string) => attributes[name] ?? null
  });
  const slider: BrowserLocator = {
    count: async () => options.sliderCount ?? 1,
    isVisible: async () => true,
    evaluate: async (fn) => fn({
      querySelector: (selector: string) => selector === "[role='slider']"
        ? {
            getAttribute: (name: string) => name === "aria-valuemin"
              ? "0"
              : name === "aria-valuemax"
                ? String(labels.length - 1)
                : name === "aria-valuenow"
                  ? String(current)
                  : null
          }
        : null,
      ownerDocument: {
        getElementById: (id: string) => id === "power-help"
          ? describedNode("Choose how much reasoning ChatGPT should use.")
          : id === "power-value"
            ? describedNode(`${labels[current] ?? ""}, ${current + 1} of ${labels.length}.`)
            : null
      },
      getAttribute: (name: string) => name === "aria-label"
        ? "Power"
        : name === "aria-describedby"
          ? "power-help power-value"
          : null
    } as unknown as Element),
    press: async (key) => {
      keys.push(key);
      current = Math.max(
        0,
        Math.min(labels.length - 1, current + (key === "ArrowRight" ? 1 : -1))
      );
    }
  };

  return {
    current: () => current,
    keys: () => [...keys],
    locator: (selector) => selector === "[role='menuitem'][aria-label='Power']"
      ? slider
      : { count: async () => 0 }
  };
}
