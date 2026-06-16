import { fileURLToPath } from "node:url";

import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import sirv from "sirv";

import { stateMetadataKey, type LoadedNamespace } from "../load-namespace.ts";
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

export const frontendRoutes = (options: {
	namespaces: ReadonlyArray<LoadedNamespace>;
	dev: boolean;
}) =>
	HttpApiBuilder.Router.use((router) =>
		Effect.gen(function* () {
			for (const namespace of options.namespaces) {
				const { namespace: name, frontend } = namespace[stateMetadataKey];
				if (typeof frontend === "undefined") {
					continue;
				}
				const spa = frontend.vite?.spa ?? false;
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
					const app = connectToHttpApp(
						sirv(coerceToPath(frontend.dir), {
							etag: true,
							single: spa,
							// Don't cache files in memory
							dev: true,
						}),
					);
					yield* router.mountApp(frontendPrefix(name), app);
				}
				yield* Effect.logInfo(
					`Serving frontend for "${name}" at ${frontendPrefix(name)}/`,
				);
			}
		}),
	);
