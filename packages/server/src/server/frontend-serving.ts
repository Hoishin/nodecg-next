import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import sirv from "sirv";

import { type WidenedImplementedNamespace } from "../implement-namespace.ts";
import { nodeMiddlewareToHttpApp } from "./node-connect-middleware.ts";
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

const sirvHttpApp = (dirPath: string | URL, single: boolean) =>
	nodeMiddlewareToHttpApp(
		sirv(coerceToPath(dirPath), {
			etag: true,
			single,
			// Don't cache files in memory
			dev: true,
		}),
		{ stripUrl: true },
	);

export const frontendRoutes = (options: {
	namespaces: ReadonlyArray<WidenedImplementedNamespace>;
	dev: boolean;
}) =>
	HttpRouter.use((router) =>
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
						prefix: frontendPrefix(name),
						spa,
					});
					yield* router
						.prefixed(frontendPrefix(name))
						.add("*", "/*", nodeMiddlewareToHttpApp(devServer.middlewares));
				} else {
					const apps = frontend.dir.map((dirPath) =>
						sirvHttpApp(dirPath, false),
					);
					if (spa) {
						apps.push(
							...frontend.dir.map((dirPath) => sirvHttpApp(dirPath, true)),
						);
					}
					yield* router.prefixed(frontendPrefix(name)).add(
						"*",
						"/*",
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
