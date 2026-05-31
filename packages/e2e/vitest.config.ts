import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	server: {
		proxy: {
			"/api": { target: "http://localhost:3000" },
			"/ws": { target: "ws://localhost:3000", ws: true },
		},
	},
	test: {
		include: ["src/**/*.test.ts"],
		globalSetup: ["./src/global-setup.ts"],
		browser: {
			enabled: true,
			provider: playwright(),
			instances: [{ browser: "chromium" }],
			headless: true,
			screenshotFailures: false,
		},
	},
});
