// hq-pets's tests (test:unit: `pnpm exec vitest run --project hq-pets`, test:integration: `--project hq-pets:integration`).
// The integration suite (*.ispec.ts) starts a real server through the testbed (plugins/sdk/testbed.ts): generous timeouts.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "hq-pets", environment: "node", include: ["test/**/*.test.ts"] } },
      { test: { name: "hq-pets:integration", environment: "node", include: ["test/**/*.ispec.ts"], testTimeout: 120_000, hookTimeout: 120_000 } },
    ],
  },
});
