import { createServer, type Server } from "node:http";

import { HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";

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
		Effect.gen(function* () {
			yield* Effect.addFinalizer(() =>
				Effect.forkDaemon(forceShutdownServer(server)),
			);
		}),
	);

export const makeNodeHttpServer = Effect.fn("makeNodeHttpServer")(function* ({
	onReady,
}: {
	onReady?: () => void;
}) {
	const server = createServer();
	if (onReady) {
		server.addListener("listening", onReady);
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				server.removeListener("listening", onReady);
			}),
		);
	}

	return boundedClose(server).pipe(
		Layer.provideMerge(NodeHttpServer.layer(() => server, { port: 3000 })),
		HttpServer.withLogAddress,
	);
});
