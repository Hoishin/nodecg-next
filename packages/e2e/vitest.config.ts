import { playwright } from "@vitest/browser-playwright";
import { defineProject } from "vitest/config";

export default defineProject({
	server: {
		proxy: {
			"/api": { target: "http://localhost:3000" },
			"/frontend": { target: "http://localhost:3000" },
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
			screenshotFailures: true,
		},
	},
});
