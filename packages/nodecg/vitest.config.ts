import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "node",
					include: ["src/**/*.test.ts"],
					exclude: ["src/client/**"],
				},
			},
			{
				test: {
					name: "client",
					include: ["src/client/**/*.test.ts"],
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: "chromium" }, { browser: "firefox" }, { browser: "webkit" }],
					},
				},
			},
		],
	},
});
