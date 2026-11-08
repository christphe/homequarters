// The web client's tests (web's test:unit: `pnpm exec vitest run`): unit tests of web/src modules and component
// tests (React Testing Library), all on jsdom. Vite resolves web/src's extensionless imports as the build does.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "web",
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
