import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";

import { Cookies, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { baseUrlCookieName } from "@nodecg/internal";
import { Effect, Layer } from "effect";

import { config } from "../server-config.ts";

const baseUrlCookieListener = Effect.gen(function* () {
	const { pathname: basePath } = yield* config.baseUrl;
	const cookie = yield* Cookies.makeCookie(baseUrlCookieName, basePath, {
		path: basePath,
	});
	const setCookieHeader = Cookies.serializeCookie(cookie);
	return (_: IncomingMessage, response: ServerResponse) => {
		response.setHeader("set-cookie", setCookieHeader);
	};
});

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
	server.addListener("request", yield* baseUrlCookieListener);
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
