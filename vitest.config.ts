import { defineConfig } from "vitest/config";

// Tests run in pure node; we exclude the dev-only gateway proxy plugin from
// vite.config.ts so the WS listener doesn't hold the test process open.
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
});
