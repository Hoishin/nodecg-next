import {
	createServer,
	type Server,
	// @effect-diagnostics-next-line nodeBuiltinImport:off
} from "node:http";

import {
	NodeHttpServer,
	type NodeHttpServerRequest,
} from "@effect/platform-node";
import { baseUrlCookieName } from "@nodecg-next/internal";
import { Effect, Layer } from "effect";
import { Cookies } from "effect/unstable/http";

import { config } from "../server-config.ts";

const baseUrlCookieListener = Effect.gen(function* () {
	const { pathname: basePath } = yield* config.baseUrl;
	const cookie = yield* Effect.fromResult(
		Cookies.makeCookie(baseUrlCookieName, basePath, { path: basePath }),
	);
	const setCookieHeader = Cookies.serializeCookie(cookie);
	return (
		_: ReturnType<typeof NodeHttpServerRequest.toIncomingMessage>,
		response: ReturnType<typeof NodeHttpServerRequest.toServerResponse>,
	) => {
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
	Layer.effectDiscard(
		Effect.addFinalizer(() => Effect.forkDetach(forceShutdownServer(server))),
	);

export const makeNodeHttpServer = Effect.fn("makeNodeHttpServer")(function* ({
	onReady,
}: {
	onReady?: (address?: string) => void;
}) {
	// TODO: check if we still need to createServer() manually on v4
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
	);
});
