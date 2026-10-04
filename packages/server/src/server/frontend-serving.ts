import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/unstable/http";

import { FieldRegistryService } from "../field-registry.ts";
import { config } from "../server-config.ts";
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

export const frontendRoutes = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const registry = yield* FieldRegistryService;
		const dev = yield* config.dev;
		for (const [name, frontend] of registry.frontend) {
			const spa = frontend.spa ?? false;
			if (dev && typeof frontend.vite !== "undefined") {
				const devServer = yield* buildViteServer({
					root: coerceToPath(frontend.vite.root),
					prefix: frontendPrefix(name),
					spa,
				});
				yield* router
					.prefixed(frontendPrefix(name))
					.add("*", "/*", nodeMiddlewareToHttpApp(devServer.middlewares));
			} else {
				const roots = frontend.dir.map(coerceToPath);
				const apps = yield* Effect.forEach(roots, (root) =>
					HttpStaticServer.make({ root, spa: false }),
				);
				if (spa) {
					apps.push(
						...(yield* Effect.forEach(roots, (root) =>
							HttpStaticServer.make({ root, spa: true }),
						)),
					);
				}
				yield* router.prefixed(frontendPrefix(name)).add(
					"GET",
					"/*",
					apps.reduce((acc, next) =>
						acc.pipe(
							Effect.catchIf(
								(error) => error.reason._tag === "RouteNotFound",
								() => next,
							),
						),
					),
				);
			}
			yield* Effect.logInfo(
				`Serving frontend for "${name}" at ${frontendPrefix(name)}/`,
			);
		}
	}),
);
