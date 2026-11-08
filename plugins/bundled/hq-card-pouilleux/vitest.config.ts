// hq-card-pouilleux's tests (test:unit: `pnpm exec vitest run --project hq-card-pouilleux`, test:integration:
// `--project hq-card-pouilleux:integration`). The integration suite (*.ispec.ts) starts a real server through the
// testbed (plugins/sdk/testbed.ts): generous timeouts, and only test:integration starts one.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "hq-card-pouilleux", environment: "node", include: ["test/**/*.test.ts"] } },
      { test: { name: "hq-card-pouilleux:integration", environment: "node", include: ["test/**/*.ispec.ts"], testTimeout: 120_000, hookTimeout: 120_000 } },
    ],
  },
});
