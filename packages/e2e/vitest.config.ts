import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	server: {
		proxy: {
			"/api": { target: "http://localhost:3000" },
			"/assets": { target: "http://localhost:3000" },
			"/ws": { target: "ws://localhost:3000", ws: true },
		},
	},
	test: {
		browser: {
			enabled: true,
			provider: playwright(),
			instances: [
				{ browser: "chromium", globalSetup: ["./src/global-setup.ts"] },
			],
			headless: true,
			screenshotFailures: false,
		},
	},
});
