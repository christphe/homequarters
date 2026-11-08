// hq-cards's tests (test:unit: `pnpm exec vitest run --project hq-cards`, test:integration: `--project hq-cards:integration`).
// Unit tests run on Node; a view test that needs a DOM says `// @vitest-environment jsdom` (test/panel.test.ts).
// The integration suite (*.ispec.ts) starts a real server through the testbed (plugins/sdk/testbed.ts): generous
// timeouts, and only test:integration starts one.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "hq-cards", environment: "node", include: ["test/**/*.test.ts"] } },
      { test: { name: "hq-cards:integration", environment: "node", include: ["test/**/*.ispec.ts"], testTimeout: 120_000, hookTimeout: 120_000 } },
    ],
  },
});
