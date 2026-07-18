import { playwright } from "@vitest/browser-playwright";
import getPort from "get-port";
import { defineProject } from "vitest/config";

import { closeLoginPopup, countPages } from "./src/server/browser-commands.ts";
import { scanSuites } from "./tests/suites.ts";

const BROWSERS = ["chromium", "firefox", "webkit"] as const;

const suites = await scanSuites();

const specs = suites
	.map((suite) =>
		suite.config.runtime.map((runtime) =>
			runtime === "node"
				? { suite, name: `e2e-${suite.name}-node`, browser: undefined }
				: BROWSERS.map((browser) => ({
						suite,
						name: `e2e-${suite.name}-${browser}`,
						browser,
					})),
		),
	)
	.flat(2); // 2 turns Array<Node> | Array<Browser> into Array<Node | Browser>

export const projects = await Promise.all(
	specs.map(async ({ suite, name, browser }, index) => {
		const port = await getPort();
		return defineProject({
			root: import.meta.dirname,
			server: {
				proxy: {
					"/api": { target: `http://localhost:${port}` },
					"/frontend": { target: `http://localhost:${port}` },
					"/ws": { target: `ws://localhost:${port}`, ws: true },
				},
			},
			test: {
				name,
				sequence: {
					groupOrder: index + 2, // 0 and 1 are unit tests
				},
				include: [`tests/${suite.name}/**/*.test.ts`],
				env: {
					PORT: String(port),
					SERVER_ENTRY: suite.serverEntry,
					SUPERADMINS: suite.config.superadmins.join(","),
				},
				browser:
					typeof browser === "undefined"
						? undefined
						: {
								enabled: true,
								provider: playwright(),
								headless: true,
								instances: [
									{ browser, globalSetup: "./src/server/global-setup.ts" },
								],
								screenshotFailures: false,
								commands: { closeLoginPopup, countPages },
							},
			},
		});
	}),
);
