import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface SuiteConfig {
	readonly runtime?: ReadonlyArray<"node" | "browser">;
	readonly superadmins?: ReadonlyArray<string>;
}

export interface Suite {
	readonly name: string;
	readonly dir: string;
	readonly serverEntry: string;
	readonly config: Required<SuiteConfig>;
}

export const scanSuites = async (): Promise<ReadonlyArray<Suite>> => {
	const base = import.meta.dirname;
	const names = fs
		.readdirSync(base, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	return Promise.all(
		names.map(async (name) => {
			const dir = path.join(base, name);
			const module: { default?: Partial<SuiteConfig> } = await import(
				pathToFileURL(path.join(dir, "config.ts")).href
			).catch((error) => {
				// Treat as empty config if suite.config.ts is missing
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "ERR_MODULE_NOT_FOUND"
				) {
					return {};
				}
				throw error;
			});
			return {
				name,
				dir,
				serverEntry: path.join(dir, "server.ts"),
				config: {
					runtime: ["browser"],
					superadmins: [],
					...module.default,
				},
			};
		}),
	);
};
