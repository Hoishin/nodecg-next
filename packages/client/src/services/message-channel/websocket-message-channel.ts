import { Socket } from "@effect/platform";
import { Layer } from "effect";

import { SocketMessageChannel } from "./socket-message-channel.ts";

export const WebSocketMessageChannel = SocketMessageChannel.pipe(
	Layer.provide(
		Socket.layerWebSocket("/ws/internal", {
			closeCodeIsError: (code) => code !== 1000 && code !== 1005,
		}),
	),
	Layer.provide(Socket.layerWebSocketConstructorGlobal),
);
