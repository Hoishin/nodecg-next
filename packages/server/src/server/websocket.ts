import {
	HttpApiBuilder,
	HttpServerRequest,
	HttpServerResponse,
	type Socket,
} from "@effect/platform";
import type { StateEncodeError } from "@nodecg/core";
import { ClientMessage, ServerMessage } from "@nodecg/internal";
import {
	Effect,
	Fiber,
	Match,
	type ParseResult,
	Schema,
	Stream,
	SynchronizedRef,
} from "effect";
import type { JsonValue } from "type-fest";

import { stateMetadataKey, type LoadedState } from "../load-state.ts";
import type { StateNotFound } from "../services/state-storage/state-storage.ts";
import {
	type RegisteredFieldInternal,
	stateFieldInternal,
} from "../state-field.ts";

const decodeClientMessage = Schema.decode(Schema.parseJson(ClientMessage));
const encodeServerMessage = Schema.encode(Schema.parseJson(ServerMessage));

type FieldInternal = RegisteredFieldInternal;

interface StateFilter {
	readonly namespace: string;
	readonly name: string;
}

// TODO: use Effect-ts Equals
const filterEquals = (a: StateFilter, b: StateFilter) =>
	a.namespace === b.namespace && a.name === b.name;

const buildRegistry = (states: ReadonlyArray<LoadedState>) => {
	const registry = new Map<string, Map<string, FieldInternal>>();
	for (const state of states) {
		const { namespace } = state[stateMetadataKey];
		const fields = registry.get(namespace) ?? new Map<string, FieldInternal>();
		for (const [name, field] of Object.entries(state)) {
			fields.set(name, field[stateFieldInternal]);
		}
		registry.set(namespace, fields);
	}
	return registry;
};

export const websocketRoute = (options: {
	states: ReadonlyArray<LoadedState>;
}) => {
	const registry = buildRegistry(options.states);

	const wsHandler = Effect.gen(function* () {
		const socket = yield* HttpServerRequest.upgrade;
		const write = yield* socket.writer;
		const subscriptions = yield* SynchronizedRef.make<
			ReadonlyArray<{
				readonly filter: StateFilter;
				readonly fiber: Fiber.RuntimeFiber<
					void,
					| ParseResult.ParseError
					| Socket.SocketError
					| StateNotFound
					| StateEncodeError
				>;
			}>
		>([]);

		const send = (msg: ServerMessage) =>
			encodeServerMessage(msg).pipe(
				Effect.andThen((encodedMessage) => write(encodedMessage)),
			);

		const publishState = (filter: StateFilter, value: JsonValue) =>
			send({ _tag: "publish", topic: "state", message: { filter, value } });

		const sendCurrent = (filter: StateFilter, internal: FieldInternal) =>
			internal
				.getEncoded()
				.pipe(Effect.flatMap((value) => publishState(filter, value)));

		const startSubscription = (filter: StateFilter) =>
			SynchronizedRef.updateEffect(subscriptions, (list) =>
				Effect.gen(function* () {
					const internal = registry.get(filter.namespace)?.get(filter.name);
					if (typeof internal === "undefined") {
						yield* Effect.logWarning(
							`Subscribe: unknown state "${filter.name}" in "${filter.namespace}"`,
						);
						return list;
					}
					if (list.some((s) => filterEquals(s.filter, filter))) {
						yield* sendCurrent(filter, internal);
						return list;
					}
					const fiber = yield* Effect.forkScoped(
						Effect.gen(function* () {
							const stream = yield* internal.subscribeEncoded();
							yield* Stream.runForEach(stream, (value) =>
								publishState(filter, value),
							);
						}).pipe(Effect.scoped),
					);
					return [...list, { filter, fiber }];
				}),
			);

		const stopSubscription = (filter: StateFilter) =>
			SynchronizedRef.updateEffect(subscriptions, (list) =>
				Effect.gen(function* () {
					const match = list.find((s) => filterEquals(s.filter, filter));
					if (typeof match === "undefined") {
						return list;
					}
					yield* Fiber.interrupt(match.fiber);
					return list.filter((s) => !filterEquals(s.filter, filter));
				}),
			);

		const handleMessage = (msg: ClientMessage) =>
			Match.value(msg).pipe(
				Match.when({ _tag: "ping", topic: "ping" }, () =>
					Effect.gen(function* () {
						yield* Effect.logDebug("Received ping");
						yield* send({ _tag: "ping", topic: "pong" });
					}),
				),
				Match.when({ _tag: "ping", topic: "pong" }, () =>
					Effect.logDebug("Received pong"),
				),
				Match.when({ _tag: "subscribe", topic: "state" }, (msg) =>
					startSubscription(msg.message.filter),
				),
				Match.when({ _tag: "unsubscribe", topic: "state" }, (msg) =>
					stopSubscription(msg.message.filter),
				),
				Match.exhaustive,
			);

		yield* socket.runRaw((data) =>
			typeof data === "string"
				? decodeClientMessage(data).pipe(Effect.flatMap(handleMessage))
				: Effect.void,
		);
		return HttpServerResponse.empty();
	});

	return HttpApiBuilder.Router.use((router) =>
		router.get(
			"/ws",
			wsHandler.pipe(
				Effect.catchAll(() =>
					Effect.succeed(HttpServerResponse.empty({ status: 500 })),
				),
			),
		),
	);
};
