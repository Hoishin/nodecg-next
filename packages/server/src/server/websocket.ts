import {
	HttpApiBuilder,
	HttpServerRequest,
	HttpServerResponse,
	type Socket,
} from "@effect/platform";
import { ClientMessage, ServerMessage } from "@nodecg/internal";
import {
	Effect,
	Fiber,
	Match,
	type ParseResult,
	Ref,
	Schema,
	Stream,
} from "effect";

import { stateMetadataKey, type LoadedState } from "../load-state.ts";
import { type StateField, stateFieldInternal } from "../models/state-field.ts";

const decodeClientMessage = Schema.decode(Schema.parseJson(ClientMessage));
const encodeServerMessage = Schema.encode(Schema.parseJson(ServerMessage));

type FieldInternal = StateField<unknown>[typeof stateFieldInternal];

interface StateFilter {
	readonly namespace: string;
	readonly name: string;
}

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
		const subscriptions = yield* Ref.make<
			ReadonlyArray<{
				readonly filter: StateFilter;
				readonly fiber: Fiber.RuntimeFiber<
					void,
					ParseResult.ParseError | Socket.SocketError
				>;
			}>
		>([]);

		const send = (msg: ServerMessage) =>
			encodeServerMessage(msg).pipe(Effect.flatMap(write));

		const startSubscription = (filter: StateFilter) =>
			Effect.gen(function* () {
				const existing = yield* Ref.get(subscriptions);
				if (existing.some((s) => filterEquals(s.filter, filter))) {
					return;
				}
				const internal = registry.get(filter.namespace)?.get(filter.name);
				if (typeof internal === "undefined") {
					yield* Effect.logWarning(
						`Subscribe: unknown state "${filter.name}" in "${filter.namespace}"`,
					);
					return;
				}
				const fiber = yield* Effect.forkScoped(
					Stream.runForEach(internal.subscribeEncoded(), (value) =>
						send({
							_tag: "publish",
							topic: "state",
							message: { filter, value },
						}),
					),
				);
				yield* Ref.update(subscriptions, (list) => [
					...list,
					{ filter, fiber },
				]);
			});

		const stopSubscription = (filter: StateFilter) =>
			Effect.gen(function* () {
				const existing = yield* Ref.get(subscriptions);
				const match = existing.find((s) => filterEquals(s.filter, filter));
				if (typeof match === "undefined") {
					return;
				}
				yield* Fiber.interrupt(match.fiber);
				yield* Ref.update(subscriptions, (list) =>
					list.filter((s) => !filterEquals(s.filter, filter)),
				);
			});

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
