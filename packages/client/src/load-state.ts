import type { StateDefinition, StateManifest } from "@nodecg/core";
import {
	mapEffectValues,
	mapValues,
	type PromisifyObject,
} from "@nodecg/internal";
import {
	Data,
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
	type MessageChannel,
	MessageChannelService,
} from "./message-channel/message-channel.ts";
import { WebSocketMessageChannel } from "./message-channel/websocket-message-channel.ts";
import { HttpStateTransport } from "./state-transport/http-state-transport.ts";
import {
	StateTransportService,
	type StateTransport,
} from "./state-transport/state-transport.ts";

export class GetStateError extends Data.TaggedError("GetStateError")<{
	readonly namespace: string;
	readonly name: string;
	readonly cause: string;
}> {
	override get message() {
		return `Failed to get state "${this.name}" in "${this.namespace}": ${this.cause}`;
	}
}

export class UpdateStateError extends Data.TaggedError("UpdateStateError")<{
	readonly namespace: string;
	readonly name: string;
	readonly cause: string;
}> {
	override get message() {
		return `Failed to update state "${this.name}" in "${this.namespace}": ${this.cause}`;
	}
}

export class SubscribeStateError extends Data.TaggedError(
	"SubscribeStateError",
)<{
	readonly namespace: string;
	readonly name: string;
	readonly cause: string;
}> {
	override get message() {
		return `Failed to subscribe to state "${this.name}" in "${this.namespace}": ${this.cause}`;
	}
}

interface StateFieldEffect<Decoded> {
	getValue: () => Effect.Effect<Decoded, GetStateError>;
	set: (value: Decoded) => Effect.Effect<void, UpdateStateError>;
	update: (
		fn: (value: Decoded) => Promisable<Decoded>,
	) => Effect.Effect<void, UpdateStateError>;
	subscribe: (
		callback: (value: Decoded) => Promisable<void>,
	) => Effect.Effect<() => void, SubscribeStateError>;
}

type StateFieldPromise<Decoded> = PromisifyObject<StateFieldEffect<Decoded>>;

const implementState = Effect.fn("implementState")(function* <Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
) {
	const transport = yield* StateTransportService;
	const messageChannel = yield* MessageChannelService;
	const layerScope = yield* Effect.scope;
	let refcount = 0;

	const getValue = Effect.fn("getValue")(
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
			const current = yield* getValue();
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

	const subscribe = Effect.fn("subscribe")(function* (
		callback: (value: Decoded) => Promisable<void>,
	) {
		const stream = Stream.acquireRelease(
			messageChannel
				.send({
					_tag: "subscribe",
					topic: "state",
					message: { filter: { namespace, name } },
				})
				.pipe(
					Effect.mapError(
						(error) =>
							new SubscribeStateError({
								namespace,
								name,
								cause: error.message,
							}),
					),
					Effect.tap(() =>
						Effect.sync(() => {
							refcount += 1;
						}),
					),
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
					Stream.mapError(
						(error) =>
							new SubscribeStateError({
								namespace,
								name,
								cause: error.message,
							}),
					),
				),
			),
		);
		const fiber = yield* Effect.forkIn(
			Stream.runForEach(stream, (value) =>
				definition
					.decode(value)
					.pipe(
						Effect.flatMap((decoded) =>
							Effect.tryPromise(async () => callback(decoded)),
						),
					),
			),
			layerScope,
		);
		return () => {
			Effect.runFork(Fiber.interrupt(fiber));
		};
	});

	const field: StateFieldEffect<Decoded> = {
		getValue,
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
		Layer.mergeAll(transportLayer, messageChannelLayer, Layer.scope),
	);

	const effectState = await runtime.runPromise(loadStateEffect(manifest));
	return mapValues<
		StateFieldEffectLambda,
		StateFieldPromiseLambda,
		Definitions
	>(effectState, (field) => ({
		getValue: () => runtime.runPromise(field.getValue()),
		set: (value) => runtime.runPromise(field.set(value)),
		update: (fn) => runtime.runPromise(field.update(fn)),
		subscribe: (callback) => runtime.runPromise(field.subscribe(callback)),
	}));
}
