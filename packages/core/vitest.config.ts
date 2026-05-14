import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "node",
					include: ["src/**/*.test.ts"],
				},
			},
			{
				test: {
					name: "browser",
					include: ["src/**/*.test.ts"],
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: "chromium" }, { browser: "firefox" }, { browser: "webkit" }],
						headless: true,
						screenshotFailures: false,
					},
				},
			},
		],
	},
});
