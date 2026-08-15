import type { BridgeTargetSnapshot } from "./types.js";
import type { BridgeTargetPort } from "./targets.js";

type PowerLocator = {
  count?: () => Promise<number>;
  isVisible?: () => Promise<boolean>;
  press?: (key: string) => Promise<void>;
  evaluate?: <T>(fn: (element: Element) => T) => Promise<T>;
  filter?: (options: Record<string, unknown>) => PowerLocator;
};

type PowerPage = {
  locator?: (selector: string) => PowerLocator;
};

const POWER_AXIS = "power";
const MAX_POWER_POSITIONS = 64;
const POWER_CONTROL_SELECTOR = "[role='menuitem'][aria-label='Power']";
const POSITION_SUFFIX = /,\s*\d+\s+of\s+\d+\.\s*$/;

export type BrowserPowerTargetErrorCode =
  | "power_unavailable"
  | "power_ambiguous"
  | "power_invalid"
  | "power_target_unavailable"
  | "power_unverified"
  | "power_restore_failed";

export class BrowserPowerTargetError extends Error {
  readonly code: BrowserPowerTargetErrorCode;

  constructor(code: BrowserPowerTargetErrorCode, message: string) {
    super(message);
    this.name = "BrowserPowerTargetError";
    this.code = code;
  }
}

/**
 * Exact English-Chat adapter for the visible Power slider's current ARIA range.
 * It owns no model labels: every option is learned from the slider's ARIA
 * announcement and inspection always restores the setting it found.
 */
export class ChatGPTPowerTargetPort implements BridgeTargetPort {
  readonly #page: PowerPage;
  #labels: string[] | undefined;

  constructor(page: PowerPage) {
    this.#page = page;
  }

  async inspectTargets(): Promise<BridgeTargetSnapshot> {
    const slider = await uniquePowerControl(this.#page);
    const original = await readPosition(slider);
    if (this.#labels !== undefined) {
      const active = this.#labels[original.now - original.min];
      if (active === undefined || await readAnnouncement(slider) !== active) {
        throw new BrowserPowerTargetError(
          "power_unverified",
          "Power slider changed since its options were inspected."
        );
      }
      return snapshot(this.#labels, original);
    }
    const labels = new Map<number, string>();

    try {
      labels.set(original.now, await readAnnouncement(slider));

      let position = original;
      while (position.now > position.min) {
        position = await pressAndVerify(slider, "ArrowLeft", position);
        labels.set(position.now, await readAnnouncement(slider));
      }

      position = await moveTo(slider, original.now, original);
      while (position.now < position.max) {
        position = await pressAndVerify(slider, "ArrowRight", position);
        labels.set(position.now, await readAnnouncement(slider));
      }

      const ordered = positions(original).map((index) => labels.get(index));
      if (ordered.some((label) => label === undefined)) {
        throw new BrowserPowerTargetError(
          "power_invalid",
          "Power slider did not announce every visible position."
        );
      }
      const exactLabels = ordered as string[];
      if (new Set(exactLabels).size !== exactLabels.length) {
        throw new BrowserPowerTargetError(
          "power_ambiguous",
          "Power slider announced duplicate option labels."
        );
      }

      this.#labels = exactLabels;
      return snapshot(exactLabels, original);
    } finally {
      await restore(slider, original);
    }
  }

  async selectTarget(axis: string, label: string): Promise<void> {
    if (axis !== POWER_AXIS) {
      throw new BrowserPowerTargetError(
        "power_target_unavailable",
        `Visible target axis ${JSON.stringify(axis)} is unavailable.`
      );
    }

    if (this.#labels === undefined) await this.inspectTargets();
    const labels = this.#labels!;
    const matches = labels.filter((option) => option === label);
    if (matches.length === 0) {
      throw new BrowserPowerTargetError(
        "power_target_unavailable",
        `Power target ${JSON.stringify(label)} is unavailable.`
      );
    }
    if (matches.length !== 1) {
      throw new BrowserPowerTargetError(
        "power_ambiguous",
        `Power target ${JSON.stringify(label)} is ambiguous.`
      );
    }

    const targetIndex = labels.findIndex((option) => option === label);
    const slider = await uniquePowerControl(this.#page);
    const original = await readPosition(slider);
    const target = original.min + targetIndex;
    let verified = false;
    try {
      const moved = await moveTo(slider, target, original);
      const announced = await readAnnouncement(slider);
      verified = moved.now === target && announced === label;
      if (!verified) {
        throw new BrowserPowerTargetError(
          "power_unverified",
          `Power target ${JSON.stringify(label)} was not verified exactly.`
        );
      }
    } finally {
      if (!verified) {
        await restore(slider, original);
      }
    }
  }
}

function snapshot(
  labels: readonly string[],
  position: PowerPosition
): BridgeTargetSnapshot {
  const selectedIndex = position.now - position.min;
  const active = labels[selectedIndex];
  if (active === undefined) {
    throw new BrowserPowerTargetError(
      "power_invalid",
      "Power slider active position has no announced label."
    );
  }
  return {
    active: { [POWER_AXIS]: active },
    options: {
      [POWER_AXIS]: labels.map((label, index) => ({
        label,
        selected: index === selectedIndex
      }))
    }
  };
}

type PowerPosition = {
  min: number;
  max: number;
  now: number;
};

async function uniquePowerControl(
  page: PowerPage
): Promise<PowerLocator> {
  const slider = page.locator?.(POWER_CONTROL_SELECTOR)?.filter?.({ visible: true })
    ?? page.locator?.(POWER_CONTROL_SELECTOR);
  if (slider?.count === undefined
    || slider.evaluate === undefined
    || slider.press === undefined) {
    throw new BrowserPowerTargetError(
      "power_unavailable",
      "Visible Chat Power slider is unavailable."
    );
  }
  const count = await slider.count();
  if (count !== 1) {
    throw new BrowserPowerTargetError(
      count > 1 ? "power_ambiguous" : "power_unavailable",
      count > 1
        ? "Visible Chat Power slider is ambiguous."
        : "Visible Chat Power slider is unavailable."
    );
  }
  if (slider.isVisible !== undefined && !await slider.isVisible()) {
    throw new BrowserPowerTargetError(
      "power_unavailable",
      "Visible Chat Power slider is hidden."
    );
  }
  return slider;
}

async function readPosition(slider: PowerLocator): Promise<PowerPosition> {
  if (slider.evaluate === undefined) {
    throw new BrowserPowerTargetError(
      "power_unavailable",
      "Power slider state cannot be read."
    );
  }
  const raw = await slider.evaluate((element) => {
    const input = element.querySelector("[role='slider']");
    return {
      min: input?.getAttribute("aria-valuemin") ?? null,
      max: input?.getAttribute("aria-valuemax") ?? null,
      now: input?.getAttribute("aria-valuenow") ?? null
    };
  });
  const min = integerAttribute(raw.min);
  const max = integerAttribute(raw.max);
  const now = integerAttribute(raw.now);
  if (min === undefined
    || max === undefined
    || now === undefined
    || max < min
    || max - min + 1 > MAX_POWER_POSITIONS
    || now < min
    || now > max) {
    throw new BrowserPowerTargetError(
      "power_invalid",
      "Power slider does not expose a valid bounded ARIA range."
    );
  }
  return { min, max, now };
}

async function readAnnouncement(slider: PowerLocator): Promise<string> {
  if (slider.evaluate === undefined) {
    throw new BrowserPowerTargetError(
      "power_unavailable",
      "Power slider announcement cannot be read."
    );
  }
  const descriptions = await slider.evaluate((element) => {
    const ids = (element.getAttribute("aria-describedby") ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return ids.flatMap((id) => {
      const node = element.ownerDocument.getElementById(id);
      if (node === null) return [];
      const ariaLive = node.getAttribute("aria-live");
      const role = node.getAttribute("role");
      return [{
        text: ((node as HTMLElement).innerText ?? node.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim(),
        announcement: (ariaLive !== null && ariaLive !== "off")
          || role === "status"
          || role === "alert"
      }];
    });
  });

  const announcements = descriptions.filter((description) => description.announcement);
  const positionAnnouncements = descriptions.filter((description) =>
    POSITION_SUFFIX.test(description.text)
  );
  const candidates = announcements.length > 0
    ? announcements
    : positionAnnouncements.length > 0
      ? positionAnnouncements
      : descriptions.length === 1
        ? descriptions
        : [];
  if (candidates.length !== 1) {
    throw new BrowserPowerTargetError(
      candidates.length > 1 ? "power_ambiguous" : "power_invalid",
      candidates.length > 1
        ? "Power slider has multiple ARIA announcements."
        : "Power slider lacks a unique ARIA announcement."
    );
  }
  const label = (candidates[0]?.text ?? "")
    .replace(POSITION_SUFFIX, "")
    .trim();
  if (label.length === 0) {
    throw new BrowserPowerTargetError(
      "power_invalid",
      "Power slider ARIA announcement is empty."
    );
  }
  return label;
}

async function pressAndVerify(
  slider: PowerLocator,
  key: "ArrowLeft" | "ArrowRight",
  before: PowerPosition
): Promise<PowerPosition> {
  if (slider.press === undefined) {
    throw new BrowserPowerTargetError(
      "power_unavailable",
      "Power slider cannot be controlled with Arrow keys."
    );
  }
  await slider.press(key);
  const after = await readPosition(slider);
  const expected = before.now + (key === "ArrowRight" ? 1 : -1);
  if (after.min !== before.min || after.max !== before.max || after.now !== expected) {
    throw new BrowserPowerTargetError(
      "power_unverified",
      `Power slider did not verify ${key} movement.`
    );
  }
  return after;
}

async function moveTo(
  slider: PowerLocator,
  target: number,
  expectedRange: Pick<PowerPosition, "min" | "max">
): Promise<PowerPosition> {
  let position = await readPosition(slider);
  if (position.min !== expectedRange.min
    || position.max !== expectedRange.max
    || target < position.min
    || target > position.max) {
    throw new BrowserPowerTargetError(
      "power_invalid",
      "Power slider range changed during control."
    );
  }
  for (let step = 0; position.now !== target && step < position.max - position.min; step += 1) {
    position = await pressAndVerify(
      slider,
      target > position.now ? "ArrowRight" : "ArrowLeft",
      position
    );
  }
  if (position.now !== target) {
    throw new BrowserPowerTargetError(
      "power_unverified",
      "Power slider did not reach the requested position."
    );
  }
  return position;
}

async function restore(slider: PowerLocator, original: PowerPosition): Promise<void> {
  try {
    const restored = await moveTo(slider, original.now, original);
    if (restored.now !== original.now) {
      throw new Error("position mismatch");
    }
  } catch {
    throw new BrowserPowerTargetError(
      "power_restore_failed",
      "Power slider original setting could not be restored."
    );
  }
}

function positions(range: Pick<PowerPosition, "min" | "max">): number[] {
  return Array.from(
    { length: range.max - range.min + 1 },
    (_, index) => range.min + index
  );
}

function integerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
