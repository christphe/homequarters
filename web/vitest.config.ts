// The web client's tests (web's test:unit: `pnpm exec vitest run`): unit tests of web/src modules on Node, and
// component tests (React Testing Library, *.test.tsx) on jsdom, which each asks for with its first line
// `// @vitest-environment jsdom` (jsdom's setup was 92 % of the suite's time when every file paid for it).
// Vite resolves web/src's extensionless imports as the build does.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "web",
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
