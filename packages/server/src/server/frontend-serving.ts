import { fileURLToPath } from "node:url";

import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import sirv from "sirv";

import { type ImplementedNamespace } from "../implement-namespace.ts";
import { connectToHttpApp } from "./connect-middleware.ts";
import { buildViteServer } from "./vite-dev-server.ts";

const frontendPrefix = (namespace: string) =>
	`/frontend/namespaces/${namespace}` as const;

const coerceToPath = (url: string | URL) => {
	if (url instanceof URL) {
		return fileURLToPath(url);
	}
	if (url.startsWith("file://")) {
		return fileURLToPath(url);
	}
	return url;
};

const staticApp = (dirPath: string | URL, single: boolean) =>
	connectToHttpApp(
		sirv(coerceToPath(dirPath), {
			etag: true,
			single,
			// Don't cache files in memory
			dev: true,
		}),
	);

export const frontendRoutes = (options: {
	namespaces: ReadonlyArray<ImplementedNamespace<{}, {}, {}, {}>>;
	dev: boolean;
}) =>
	HttpApiBuilder.Router.use((router) =>
		Effect.gen(function* () {
			for (const { manifest, impl } of options.namespaces) {
				const name = manifest.namespace;
				const frontend = impl?.frontend;
				if (typeof frontend === "undefined") {
					continue;
				}
				const spa = frontend.spa ?? false;
				if (options.dev && typeof frontend.vite !== "undefined") {
					const devServer = yield* buildViteServer({
						root: coerceToPath(frontend.vite.root),
						base: `${frontendPrefix(name)}/`,
						spa,
					});
					yield* router.mountApp(
						frontendPrefix(name),
						connectToHttpApp(devServer.middlewares),
						{ includePrefix: true },
					);
				} else {
					const exact = frontend.dir.map((dirPath) =>
						staticApp(dirPath, false),
					);
					// Fallback pass runs only after every dir missed the exact path, so an exact match in any dir wins and the first dir with an index.html serves the fallback
					const apps = spa
						? [
								...exact,
								...frontend.dir.map((dirPath) => staticApp(dirPath, true)),
							]
						: exact;
					yield* router.mountApp(
						frontendPrefix(name),
						apps.reduce((acc, next) =>
							acc.pipe(Effect.catchTag("RouteNotFound", () => next)),
						),
					);
				}
				yield* Effect.logInfo(
					`Serving frontend for "${name}" at ${frontendPrefix(name)}/`,
				);
			}
		}),
	);
