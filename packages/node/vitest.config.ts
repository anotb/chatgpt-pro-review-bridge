import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Git- and filesystem-heavy review tests can legitimately exceed Vitest's
    // 5s default on a contended Windows runner. This ceiling does not delay
    // passing tests; it only avoids treating ordinary I/O variance as a hang.
    testTimeout: 20_000
  }
});
