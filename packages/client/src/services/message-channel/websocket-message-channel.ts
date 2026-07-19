import { Path, Socket } from "@effect/platform";
import { Effect, Layer } from "effect";

import { SocketMessageChannel } from "./socket-message-channel.ts";

// TODO: infer this from HttpApi from internal or have internal const
const wsPath = "ws/internal";

const wsUrl = Effect.fn("wsUrl")(function* (baseUrl?: string) {
	if (!baseUrl) {
		return `/${wsPath}`;
	}
	const path = yield* Path.Path;
	const url = new URL(baseUrl);
	url.pathname = path.join(url.pathname, wsPath);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
});

export const webSocketMessageChannel = (baseUrl?: string) => {
	return SocketMessageChannel.pipe(
		Layer.provide(
			Layer.effect(
				Socket.Socket,
				Effect.gen(function* () {
					const websocketUrl = yield* wsUrl(baseUrl);
					return yield* Socket.makeWebSocket(websocketUrl, {
						closeCodeIsError: (code) => code !== 1000 && code !== 1005,
					});
				}),
			),
		),
		Layer.provide(Socket.layerWebSocketConstructorGlobal),
	);
};
