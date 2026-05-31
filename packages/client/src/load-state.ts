import type { StateDefinition, StateManifest } from "@nodecg/core";
import { mapEffectValues, mapValues } from "@nodecg/internal";
import {
	Effect,
	Fiber,
	type HKT,
	Layer,
	ManagedRuntime,
	Match,
	Option,
	type Schema,
	Stream,
} from "effect";
import type { Promisable } from "type-fest";

import {
	GetStateError,
	type StateFieldEffect,
	type StateFieldPromise,
	StateSubscriptionError,
	StateValueError,
	UpdateStateError,
} from "./models/state-field.ts";
import {
	type MessageChannel,
	MessageChannelService,
} from "./services/message-channel/message-channel.ts";
import { WebSocketMessageChannel } from "./services/message-channel/websocket-message-channel.ts";
import { HttpStateTransport } from "./services/state-transport/http-state-transport.ts";
import {
	StateTransportService,
	type StateTransport,
} from "./services/state-transport/state-transport.ts";

const implementState = Effect.fn("implementState")(function* <Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
) {
	const transport = yield* StateTransportService;
	const messageChannel = yield* MessageChannelService;
	let refcount = 0;

	const get = Effect.fn("get")(
		function* () {
			const current = yield* transport.read(namespace, name);
			return yield* definition.decode(current);
		},
		Effect.mapError(
			(error) => new GetStateError({ namespace, name, cause: error.message }),
		),
	);

	const set = Effect.fn("set")(
		function* (value: Decoded) {
			const encoded = yield* definition.encode(value);
			yield* transport.update(namespace, name, encoded);
		},
		Effect.mapError(
			(error) =>
				new UpdateStateError({ namespace, name, cause: error.message }),
		),
	);

	const update = Effect.fn("update")(
		function* (fn: (value: Decoded) => Promisable<Decoded>) {
			const current = yield* get();
			const next = yield* Effect.tryPromise(async () => fn(current));
			const encoded = yield* definition.encode(next);
			yield* transport.update(namespace, name, encoded);
		},
		Effect.mapError((error) => {
			const cause = Match.value(error).pipe(
				Match.tag(
					"UnknownException",
					"GetStateError",
					"StateValidationError",
					"StateNotFound",
					"StateSaveFailed",
					(e) => e.message,
				),
				Match.exhaustive,
			);
			return new UpdateStateError({ namespace, name, cause });
		}),
	);

	const subscribe = () =>
		Stream.acquireRelease(
			messageChannel
				.send({
					_tag: "subscribe",
					topic: "state",
					message: { filter: { namespace, name } },
				})
				.pipe(
					Effect.mapError((cause) => new StateSubscriptionError({ cause })),
					Effect.andThen(() => {
						refcount += 1;
					}),
				),
			() =>
				Effect.gen(function* () {
					refcount -= 1;
					if (refcount > 0) {
						return;
					}
					yield* messageChannel
						.send({
							_tag: "unsubscribe",
							topic: "state",
							message: { filter: { namespace, name } },
						})
						.pipe(
							Effect.catchAll((error) =>
								Effect.logError(
									`Failed to send unsubscribe for "${namespace}/${name}":`,
									error,
								),
							),
						);
				}),
		).pipe(
			Stream.flatMap(() =>
				messageChannel.messages.pipe(
					Stream.filterMap((msg) =>
						msg._tag === "publish" &&
						msg.message.filter.namespace === namespace &&
						msg.message.filter.name === name
							? Option.some(msg.message.value)
							: Option.none(),
					),
					Stream.mapError((cause) => new StateSubscriptionError({ cause })),
				),
			),
			Stream.mapEffect((value) =>
				definition
					.decode(value)
					.pipe(
						Effect.mapError(
							(cause) => new StateValueError({ namespace, name, cause }),
						),
					),
			),
		);

	const field: StateFieldEffect<Decoded> = {
		get,
		set,
		update,
		subscribe,
	};
	return field;
});

interface StateDefinitionLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateDefinition<Schema.Schema.Type<this["Target"]>>;
}

interface StateFieldEffectLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateFieldEffect<Schema.Schema.Type<this["Target"]>>;
}

interface StateFieldPromiseLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateFieldPromise<Schema.Schema.Type<this["Target"]>>;
}

export function loadStateEffect<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
>(manifest: StateManifest<Definitions>) {
	return Effect.gen(function* () {
		return yield* mapEffectValues<
			StateDefinitionLambda,
			StateFieldEffectLambda,
			Definitions
		>()(manifest.definitions, (definition, name) =>
			implementState(manifest.namespace, name, definition),
		);
	});
}

export async function loadState<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
>({
	manifest,
	stateTransport,
	messageChannel,
}: {
	manifest: StateManifest<Definitions>;
	stateTransport?:
		| (() => StateTransport)
		| Effect.Effect<StateTransport, never, never>;
	messageChannel?:
		| (() => MessageChannel)
		| Effect.Effect<MessageChannel, never, never>;
}) {
	const transportLayer = stateTransport
		? Effect.isEffect(stateTransport)
			? Layer.effect(StateTransportService, stateTransport)
			: Layer.sync(StateTransportService, stateTransport)
		: HttpStateTransport;

	const messageChannelLayer = messageChannel
		? Effect.isEffect(messageChannel)
			? Layer.effect(MessageChannelService, messageChannel)
			: Layer.sync(MessageChannelService, messageChannel)
		: WebSocketMessageChannel;

	const runtime = ManagedRuntime.make(
		Layer.mergeAll(transportLayer, messageChannelLayer),
	);

	const effectState = await runtime.runPromise(loadStateEffect(manifest));
	return mapValues<
		StateFieldEffectLambda,
		StateFieldPromiseLambda,
		Definitions
	>(effectState, (field) => ({
		get: () => runtime.runPromise(field.get()),
		set: (value) => runtime.runPromise(field.set(value)),
		update: (fn) => runtime.runPromise(field.update(fn)),
		subscribe: (callback) => {
			const fiber = field.subscribe().pipe(
				Stream.runForEach((value) =>
					Effect.tryPromise(async () => callback(value)),
				),
				runtime.runFork,
			);
			return () => {
				runtime.runFork(Fiber.interrupt(fiber));
			};
		},
	}));
}
