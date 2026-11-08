// The SDK's tests (test:integration: `pnpm exec vitest run --project sdk:integration`): the testbed itself, against
// a real server (testbed.ts): generous timeouts.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "sdk:integration", environment: "node", include: ["test/**/*.ispec.ts"], testTimeout: 120_000, hookTimeout: 120_000 } },
    ],
  },
});
