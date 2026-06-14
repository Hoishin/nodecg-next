import { fileURLToPath } from "node:url";

import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import sirv from "sirv";

import { stateMetadataKey, type LoadedNamespace } from "../load-namespace.ts";
import { connectToHttpApp } from "./connect-middleware.ts";
import { buildViteServer } from "./vite-asset-dev-server.ts";

const assetPrefix = (namespace: string) =>
	`/assets/namespaces/${namespace}` as const;

const coerceToPath = (url: string | URL) => {
	if (url instanceof URL) {
		return fileURLToPath(url);
	}
	if (url.startsWith("file://")) {
		return fileURLToPath(url);
	}
	return url;
};

export const assetRoutes = (options: {
	namespaces: ReadonlyArray<LoadedNamespace>;
	dev: boolean;
}) =>
	HttpApiBuilder.Router.use((router) =>
		Effect.gen(function* () {
			for (const namespace of options.namespaces) {
				const { namespace: name, assets } = namespace[stateMetadataKey];
				if (typeof assets === "undefined") {
					continue;
				}
				const spa = assets.vite?.spa ?? false;
				if (options.dev && typeof assets.vite !== "undefined") {
					const devServer = yield* buildViteServer({
						root: coerceToPath(assets.vite.root),
						base: `${assetPrefix(name)}/`,
						spa,
					});
					yield* router.mountApp(
						assetPrefix(name),
						connectToHttpApp(devServer.middlewares),
						{ includePrefix: true },
					);
				} else {
					const app = connectToHttpApp(
						sirv(coerceToPath(assets.dir), {
							etag: true,
							single: spa,
							// Don't cache files in memory
							dev: true,
						}),
					);
					yield* router.mountApp(assetPrefix(name), app);
				}
				yield* Effect.logInfo(
					`Serving assets for "${name}" at ${assetPrefix(name)}/`,
				);
			}
		}),
	);
