import { createServer, type Server } from "node:http";

import { HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { config } from "../server-config.ts";

const forceShutdownServer = Effect.fn("forceShutdownServer")(function* (
	server: Server,
) {
	yield* Effect.logInfo("Server stopping");
	yield* Effect.sleep("3 seconds");
	yield* Effect.logWarning("Graceful shutdown exceeded timeout");
	yield* Effect.sync(() => {
		server.closeAllConnections();
	});
});

const boundedClose = (server: Server) =>
	Layer.scopedDiscard(
		Effect.addFinalizer(() => Effect.forkDaemon(forceShutdownServer(server))),
	);

export const makeNodeHttpServer = Effect.fn("makeNodeHttpServer")(function* ({
	onReady,
}: {
	onReady?: (address?: string) => void;
}) {
	const server = createServer();
	if (onReady) {
		const handleListening = () => {
			const address = server.address();
			onReady(typeof address === "string" ? address : address?.address);
		};
		server.addListener("listening", handleListening);
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				server.removeListener("listening", handleListening);
			}),
		);
	}

	const port = yield* config.port;
	return boundedClose(server).pipe(
		Layer.provideMerge(NodeHttpServer.layer(() => server, { port })),
		HttpServer.withLogAddress,
	);
});
