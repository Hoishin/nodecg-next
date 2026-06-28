import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import type { NamespaceManifest, FieldManifest } from "@nodecg/core";
import { NodecgApi, type FieldIdentifier } from "@nodecg/internal";
import {
	mapEffectValues,
	mapValues,
	type EffectToPromiseLambda,
	type StreamToSubscribeLambda,
	type ApplyLambdaToObject,
} from "@nodecg/internal/utils";
import {
	Effect,
	Exit,
	type HKT,
	Layer,
	ManagedRuntime,
	Match,
	Option,
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

const implementSubscription = Effect.fn("implementSubscription")(function* <
	Decoded,
>(field: FieldIdentifier, manifest: FieldManifest<Decoded>) {
	const messageChannel = yield* MessageChannelService;
	const latest = yield* SubscriptionRef.make<Option.Option<Decoded>>(
		Option.none(),
	);
	let refcount = 0;

	const stream = yield* messageChannel.receive();

	yield* Effect.forkScoped(
		stream.pipe(
			Stream.filterMap((msg) =>
				Match.value(msg).pipe(
					Match.when({ _tag: "publish", field }, (msg) =>
						Option.some(msg.value),
					),
					Match.orElse(() => Option.none()),
				),
			),
			Stream.runForEach((value) =>
				manifest.decode(value).pipe(
					Effect.flatMap((decoded) =>
						SubscriptionRef.set(latest, Option.some(decoded)),
					),
					Effect.catchAll((error) =>
						Effect.logError(
							`Failed to decode published value for "${field.namespace}/${field.name}":`,
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
						yield* messageChannel.send({ _tag: "subscribe", field });
					}
				}),
				() =>
					Effect.gen(function* () {
						refcount -= 1;
						if (refcount > 0) {
							return;
						}
						yield* messageChannel
							.send({ _tag: "unsubscribe", field })
							.pipe(
								Effect.catchAll((error) =>
									Effect.logError(
										`Failed to send unsubscribe for "${field.namespace}/${field.name}":`,
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

	return subscribe;
});

const implementState = Effect.fn("implementState")(function* <Decoded>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
) {
	const transport = yield* StateTransportService;
	const subscribe = yield* implementSubscription(
		{ type: "state", namespace, name },
		manifest,
	);

	const get = Effect.fn("get")(function* () {
		const current = yield* transport.readState(namespace, name);
		return yield* manifest.decode(current);
	});

	const set = Effect.fn("set")(function* (value: Decoded) {
		const encoded = yield* manifest.encode(value);
		yield* transport.updateState(namespace, name, encoded);
	});

	const update = Effect.fn("update")(function* (
		fn: (value: Decoded) => Promisable<Decoded>,
	) {
		const current = yield* get();
		const next = yield* Effect.tryPromise(async () => fn(current));
		const encoded = yield* manifest.encode(next);
		yield* transport.updateState(namespace, name, encoded);
	});

	return { get, set, update, subscribe };
});

type StateFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof implementState<Decoded>>
>;
export type StateField<Decoded> = ApplyLambdaToObject<
	StateFieldEffect<Decoded>,
	{
		get: EffectToPromiseLambda;
		set: EffectToPromiseLambda;
		update: EffectToPromiseLambda;
		subscribe: StreamToSubscribeLambda;
	}
>;

const implementComputed = Effect.fn("implementComputed")(function* <Decoded>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
) {
	const transport = yield* StateTransportService;
	const subscribe = yield* implementSubscription(
		{ type: "computed", namespace, name },
		manifest,
	);

	const get = Effect.fn("get")(function* () {
		const current = yield* transport.readComputed(namespace, name);
		return yield* manifest.decode(current);
	});

	return { get, subscribe };
});

type ComputedFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof implementComputed<Decoded>>
>;
export type ComputedField<Decoded> = ApplyLambdaToObject<
	ComputedFieldEffect<Decoded>,
	{
		get: EffectToPromiseLambda;
		subscribe: StreamToSubscribeLambda;
	}
>;

interface FieldManifestLambda extends HKT.TypeLambda {
	readonly type: FieldManifest<this["Target"]>;
}

interface StateFieldEffectLambda extends HKT.TypeLambda {
	readonly type: StateFieldEffect<this["Target"]>;
}

interface StateFieldPromiseLambda extends HKT.TypeLambda {
	readonly type: StateField<this["Target"]>;
}

interface ComputedFieldEffectLambda extends HKT.TypeLambda {
	readonly type: ComputedFieldEffect<this["Target"]>;
}

interface ComputedFieldPromiseLambda extends HKT.TypeLambda {
	readonly type: ComputedField<this["Target"]>;
}

const buildNamespace = <
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
>(
	manifest: NamespaceManifest<State, Computed, Topic>,
) =>
	Effect.gen(function* () {
		const fields = yield* mapEffectValues<
			FieldManifestLambda,
			StateFieldEffectLambda
		>()((codec, name) => implementState(manifest.namespace, name, codec))(
			manifest.state,
		);
		const computedFields = yield* mapEffectValues<
			FieldManifestLambda,
			ComputedFieldEffectLambda
		>()((codec, name) => implementComputed(manifest.namespace, name, codec))(
			manifest.computed,
		);
		return { fields, computedFields };
	});

const buildHttpClient = Effect.fn("buildHttpClient")(function* () {
	const httpClient = yield* HttpApiClient.make(NodecgApi);
	return {
		me: httpClient.Authentication.me,
		logout: httpClient.Authentication.logout,
	};
});

export const loadNamespaceEffect = Effect.fn("loadNamespaceEffect")(function* <
	State extends Record<string, unknown> = {},
	Computed extends Record<string, unknown> = {},
	Topic extends Record<string, unknown> = {},
>(manifest: NamespaceManifest<State, Computed, Topic>) {
	const httpClient = yield* buildHttpClient();
	return yield* buildNamespace(manifest).pipe(
		Effect.map(({ fields, computedFields }) => ({
			state: fields,
			computed: computedFields,
			httpClient,
		})),
	);
});

export interface LoadedNamespace<
	State extends Record<string, unknown> = Record<string, unknown>,
	Computed extends Record<string, unknown> = Record<string, unknown>,
> {
	readonly state: {
		readonly [K in keyof State & string]: StateField<State[K]>;
	};
	readonly computed: {
		readonly [K in keyof Computed & string]: ComputedField<Computed[K]>;
	};
	httpClient: Effect.Effect.Success<
		ReturnType<typeof loadNamespaceEffect>
	>["httpClient"];
	readonly dispose: () => void;
	readonly [Symbol.dispose]: () => void;
}

export async function loadNamespace<
	State extends Record<string, unknown> = {},
	Computed extends Record<string, unknown> = {},
	Topic extends Record<string, unknown> = {},
>(
	manifest: NamespaceManifest<State, Computed, Topic>,
	adapter?: {
		stateTransport?:
			| (() => StateTransport)
			| Effect.Effect<StateTransport, never, never>;
		messageChannel?:
			| (() => MessageChannel)
			| Effect.Effect<MessageChannel, never, never>;
	},
): Promise<LoadedNamespace<State, Computed>> {
	const stateTransport = adapter?.stateTransport;
	const messageChannel = adapter?.messageChannel;

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
		Layer.mergeAll(
			transportLayer,
			messageChannelLayer,
			FetchHttpClient.layer,
			Layer.scope,
		),
	);

	const { fields: effectFields, computedFields: effectComputedFields } =
		await runtime.runPromise(buildNamespace(manifest));

	const subscribeEffectToPromise =
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
					return () => runtime.runPromise(Scope.close(scope, Exit.void));
				}),
			);

	const state = mapValues<StateFieldEffectLambda, StateFieldPromiseLambda>(
		(field, name) => ({
			get: () => runtime.runPromise(field.get()),
			set: (value) => runtime.runPromise(field.set(value)),
			update: (fn) => runtime.runPromise(field.update(fn)),
			subscribe: subscribeEffectToPromise(field.subscribe, name),
		}),
	)(effectFields);

	const computed = mapValues<
		ComputedFieldEffectLambda,
		ComputedFieldPromiseLambda
	>((field, name) => ({
		get: () => runtime.runPromise(field.get()),
		subscribe: subscribeEffectToPromise(field.subscribe, name),
	}))(effectComputedFields);

	return {
		state,
		computed,
		httpClient: runtime.runSync(buildHttpClient()),
		dispose: runtime.dispose,
		[Symbol.dispose]: () => runtime.dispose(),
	};
}
