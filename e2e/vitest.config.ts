// The suite's own unit tests (e2e's test:unit: `pnpm exec vitest run`), on Node; scenarios are run by run.ts, not by Vitest.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "e2e", environment: "node", include: ["*.test.ts"] },
});
