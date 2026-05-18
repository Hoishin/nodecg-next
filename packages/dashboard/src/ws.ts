import { type ClientMessage, ServerMessage } from "@nodecg/internal";
import { Effect, Fiber, Ref, Schema, Stream, SubscriptionRef } from "effect";
import { useSyncExternalStore } from "react";

type WsState = "connecting" | "open" | "closed";

const decodeServerMessage = Schema.decodeUnknown(
	Schema.parseJson(ServerMessage),
);

const resource = Effect.runSync(
	Effect.gen(function* () {
		const stateRef = yield* SubscriptionRef.make<WsState>("connecting");
		const socketRef = yield* Ref.make<WebSocket | null>(null);
		const messageRef = yield* SubscriptionRef.make<ServerMessage | null>(null);
		return { stateRef, socketRef, messageRef };
	}),
);

// One connection lifecycle; resolves with the close code.
const connection = Effect.gen(function* () {
	yield* SubscriptionRef.set(resource.stateRef, "connecting");
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const ws = new WebSocket(`${proto}//${location.host}/ws`);

	ws.addEventListener("open", () => {
		Effect.runFork(SubscriptionRef.set(resource.stateRef, "open"));
	});
	ws.addEventListener("message", (event) => {
		if (typeof event.data !== "string") {
			return;
		}
		Effect.runFork(
			decodeServerMessage(event.data).pipe(
				Effect.flatMap((msg) => SubscriptionRef.set(resource.messageRef, msg)),
				Effect.ignore,
			),
		);
	});

	yield* Ref.set(resource.socketRef, ws);

	const code = yield* Effect.async<number>((resume) => {
		ws.addEventListener("close", (event) => {
			resume(Effect.succeed(event.code));
		});
	});

	yield* SubscriptionRef.set(resource.stateRef, "closed");
	yield* Ref.set(resource.socketRef, null);
	yield* Effect.log(`ws closed: ${code}`);
	return code;
});

// Reconnect (once, after 3s) only on transient/server-side closes. Protocol,
// policy, intentional, and app-defined codes won't recover by retrying.
const reconnectCodes = new Set([1001, 1005, 1006, 1011, 1012, 1013, 1014]);

Effect.runFork(
	Effect.gen(function* () {
		let code = yield* connection;
		while (reconnectCodes.has(code)) {
			yield* Effect.sleep("3 seconds");
			code = yield* connection;
		}
	}),
);

export const sendMessage = (msg: ClientMessage): void => {
	Effect.runFork(
		Ref.get(resource.socketRef).pipe(
			Effect.flatMap((ws) =>
				ws && ws.readyState === WebSocket.OPEN
					? Effect.sync(() => ws.send(JSON.stringify(msg)))
					: Effect.logWarning(`ws not open; dropping ${msg._tag}`),
			),
		),
	);
};

const subscribeWsState = (cb: () => void) => {
	const fiber = Effect.runFork(
		resource.stateRef.changes.pipe(Stream.runForEach(() => Effect.sync(cb))),
	);
	return () => {
		Effect.runFork(Fiber.interrupt(fiber));
	};
};
const getWsState = () => Effect.runSync(SubscriptionRef.get(resource.stateRef));

const subscribeLastMessage = (cb: () => void) => {
	const fiber = Effect.runFork(
		resource.messageRef.changes.pipe(Stream.runForEach(() => Effect.sync(cb))),
	);
	return () => {
		Effect.runFork(Fiber.interrupt(fiber));
	};
};
const getLastMessage = () =>
	Effect.runSync(SubscriptionRef.get(resource.messageRef));

export const useWsState = (): WsState =>
	useSyncExternalStore(subscribeWsState, getWsState);

export const useLastMessage = (): ServerMessage | null =>
	useSyncExternalStore(subscribeLastMessage, getLastMessage);
