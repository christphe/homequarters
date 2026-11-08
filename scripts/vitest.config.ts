// The repository scripts' tests (scripts' test:unit: `pnpm exec vitest run`), on Node.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "scripts", environment: "node", include: ["*.test.ts"] },
});
