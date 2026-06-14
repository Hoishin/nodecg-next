import { Effect } from "effect";

export const buildViteServer = (options: {
	readonly root: string;
	readonly base: string;
	readonly spa: boolean;
}) =>
	Effect.acquireRelease(
		Effect.promise(async () => {
			const { createServer } = await import("vite");
			return createServer({
				root: options.root,
				base: options.base,
				appType: options.spa ? "spa" : "mpa",
				server: { middlewareMode: true },
			});
		}),
		(server) => Effect.promise(() => server.close()),
	);
