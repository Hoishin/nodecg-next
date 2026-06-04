import type { StateDefinition, StateManifest } from "@nodecg/core";
import { mapEffectValues, mapValues } from "@nodecg/internal";
import {
	Effect,
	Exit,
	type HKT,
	Layer,
	ManagedRuntime,
	Option,
	type Schema,
	Scope,
	Stream,
	SubscriptionRef,
} from "effect";
import type { Promisable } from "type-fest";

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
import {
	type ComputedFieldEffect,
	type ComputedFieldPromise,
	GetStateError,
	type StateFieldEffect,
	type StateFieldPromise,
	StateSubscriptionError,
	UpdateStateError,
} from "./state-field.ts";

const implementState = Effect.fn("implementState")(function* <Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
) {
	const transport = yield* StateTransportService;
	const messageChannel = yield* MessageChannelService;
	const latest = yield* SubscriptionRef.make<Option.Option<Decoded>>(
		Option.none(),
	);
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
			(error) => new UpdateStateError({ namespace, name, cause: error }),
		),
	);

	const update = Effect.fn("update")(
		function* (fn: (value: Decoded) => Promisable<Decoded>) {
			const current = yield* get();
			const next = yield* Effect.tryPromise(async () => fn(current));
			const encoded = yield* definition.encode(next);
			yield* transport.update(namespace, name, encoded);
		},
		Effect.mapError(
			(error) => new UpdateStateError({ namespace, name, cause: error }),
		),
	);

	const stream = yield* messageChannel.receive();

	yield* Effect.forkScoped(
		stream.pipe(
			Stream.filterMap((msg) =>
				msg._tag === "publish" &&
				msg.message.filter.namespace === namespace &&
				msg.message.filter.name === name
					? Option.some(msg.message.value)
					: Option.none(),
			),
			Stream.runForEach((value) =>
				definition.decode(value).pipe(
					Effect.flatMap((decoded) =>
						SubscriptionRef.set(latest, Option.some(decoded)),
					),
					Effect.catchAll((error) =>
						Effect.logError(
							`Failed to decode published value for "${namespace}/${name}":`,
							error,
						),
					),
				),
			),
		),
	);

	const subscribe = () =>
		Effect.gen(function* () {
			yield* Effect.acquireRelease(
				Effect.gen(function* () {
					refcount += 1;
					if (refcount === 1) {
						yield* messageChannel
							.send({
								_tag: "subscribe",
								topic: "state",
								message: { filter: { namespace, name } },
							})
							.pipe(
								Effect.mapError(
									(cause) => new StateSubscriptionError({ cause }),
								),
							);
					}
				}),
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
			);

			yield* latest.changes.pipe(
				Stream.filterMap((value) => value),
				Stream.take(1),
				Stream.runDrain,
			);

			return latest.changes.pipe(Stream.filterMap((value) => value));
		});

	const field: StateFieldEffect<Decoded> = {
		get,
		set,
		update,
		subscribe,
	};
	return field;
});

const implementComputedState = Effect.fn("implementComputedState")(function* <
	Decoded,
>(namespace: string, name: string, definition: StateDefinition<Decoded>) {
	const field = yield* implementState(namespace, name, definition);
	const computed: ComputedFieldEffect<Decoded> = {
		get: field.get,
		subscribe: field.subscribe,
	};
	return computed;
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

interface ComputedFieldEffectLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: ComputedFieldEffect<Schema.Schema.Type<this["Target"]>>;
}

interface ComputedFieldPromiseLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: ComputedFieldPromise<Schema.Schema.Type<this["Target"]>>;
}

const buildState = <
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
>(
	manifest: StateManifest<Definitions, Computed>,
) =>
	Effect.gen(function* () {
		const fields = yield* mapEffectValues<
			StateDefinitionLambda,
			StateFieldEffectLambda,
			Definitions
		>()(manifest.definitions, (definition, name) =>
			implementState(manifest.namespace, name, definition),
		);
		const computedFields = yield* mapEffectValues<
			StateDefinitionLambda,
			ComputedFieldEffectLambda,
			Computed
		>()(manifest.computed, (definition, name) =>
			implementComputedState(manifest.namespace, name, definition),
		);
		return { fields, computedFields };
	});

export function loadStateEffect<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
>(manifest: StateManifest<Definitions, Computed>) {
	return buildState(manifest).pipe(
		Effect.map(({ fields, computedFields }) => ({
			...fields,
			...computedFields,
		})),
	);
}

export async function loadState<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
>({
	manifest,
	stateTransport,
	messageChannel,
}: {
	manifest: StateManifest<Definitions, Computed>;
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

	// TODO: expose a cleanup function that calls runtime.dispose()
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(transportLayer, messageChannelLayer, Layer.scope),
	);

	const { fields: effectFields, computedFields: effectComputedFields } =
		await runtime.runPromise(buildState(manifest));

	const subscribeAdapter =
		<Decoded, E>(
			subscribe: () => Effect.Effect<Stream.Stream<Decoded>, E, Scope.Scope>,
			name: string,
		) =>
		async (callback: (value: Decoded) => Promisable<void>) =>
			runtime.runPromise(
				Effect.gen(function* () {
					const scope = yield* Scope.make();
					const stream = yield* subscribe().pipe(Scope.extend(scope));
					yield* stream.pipe(
						Stream.runForEach((value) =>
							Effect.tryPromise(async () => callback(value)).pipe(
								Effect.catchAll((error) =>
									Effect.logError(
										`State subscription handler for "${manifest.namespace}/${name}" threw`,
										error,
									),
								),
							),
						),
						Effect.forkIn(scope),
					);
					return () => runtime.runFork(Scope.close(scope, Exit.void));
				}),
			);

	const fields = mapValues<
		StateFieldEffectLambda,
		StateFieldPromiseLambda,
		Definitions
	>(effectFields, (field, name) => ({
		get: () => runtime.runPromise(field.get()),
		set: (value) => runtime.runPromise(field.set(value)),
		update: (fn) => runtime.runPromise(field.update(fn)),
		subscribe: subscribeAdapter(field.subscribe, name),
	}));

	const computedFields = mapValues<
		ComputedFieldEffectLambda,
		ComputedFieldPromiseLambda,
		Computed
	>(effectComputedFields, (field, name) => ({
		get: () => runtime.runPromise(field.get()),
		subscribe: subscribeAdapter(field.subscribe, name),
	}));

	return { ...fields, ...computedFields };
}
