import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const NODE_TESTS = [
	// "packages/client",
	"packages/core",
	"packages/internal",
	"packages/server",
];

const BROWSER_TESTS = ["packages/client", "packages/core", "packages/internal"];

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "node-unit",
					include: NODE_TESTS.map(
						(projectPath) => `${projectPath}/**/*.test.ts`,
					),
				},
			},
			{
				test: {
					name: "browser-unit",
					include: BROWSER_TESTS.map(
						(projectPath) => `${projectPath}/**/*.test.ts`,
					),
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [
							{ browser: "firefox" },
							{ browser: "webkit" },
							{ browser: "chromium" },
						],
						screenshotFailures: false,
					},
				},
			},
			"packages/e2e",
		],
	},
});
