import type { ClientMessage } from "@nodecg/internal";
import { Effect, Fiber, Ref, Stream, SubscriptionRef } from "effect";
import { useSyncExternalStore } from "react";

type WsState = "connecting" | "open" | "closed";

const resource = Effect.runSync(
	Effect.gen(function* () {
		const stateRef = yield* SubscriptionRef.make<WsState>("connecting");
		const socketRef = yield* Ref.make<WebSocket | null>(null);
		return { stateRef, socketRef };
	}),
);

const openSocket = Effect.gen(function* () {
	const current = yield* Ref.get(resource.socketRef);

	if (
		current &&
		(current.readyState === WebSocket.CONNECTING ||
			current.readyState === WebSocket.OPEN)
	) {
		return current;
	}

	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const ws = new WebSocket(`${proto}//${location.host}/ws`);

	ws.addEventListener("open", () => {
		Effect.runFork(SubscriptionRef.set(resource.stateRef, "open"));
	});
	ws.addEventListener("close", () => {
		Effect.runFork(
			Effect.all([
				SubscriptionRef.set(resource.stateRef, "closed"),
				Ref.set(resource.socketRef, null),
			]),
		);
	});

	yield* Ref.set(resource.socketRef, ws);
	yield* SubscriptionRef.set(resource.stateRef, "connecting");

	return ws;
});

export const sendMessage = (msg: ClientMessage): void => {
	Effect.runFork(
		openSocket.pipe(
			Effect.flatMap((ws) =>
				ws.readyState === WebSocket.OPEN
					? Effect.sync(() => ws.send(JSON.stringify(msg)))
					: Effect.logWarning(`ws not open; dropping ${msg._tag}`),
			),
		),
	);
};

export const useWsState = (): WsState =>
	useSyncExternalStore(
		(cb) => {
			Effect.runFork(openSocket);
			const fiber = Effect.runFork(
				resource.stateRef.changes.pipe(Stream.runForEach(() => Effect.sync(cb))),
			);
			return () => {
				Effect.runFork(Fiber.interrupt(fiber));
			};
		},
		() => Effect.runSync(SubscriptionRef.get(resource.stateRef)),
	);
