import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import type {
	NamespaceManifest,
	FieldManifest,
	RpcFieldManifest,
} from "@nodecg/core";
import {
	InternalApi,
	type FieldIdentifier,
	fieldIdentifierEquivalence,
} from "@nodecg/internal";
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
	FieldNotFound,
	FieldPermissionDenied,
	FieldTransportService,
	type FieldTransport,
} from "./services/field-transport/field-transport.ts";
import { HttpFieldTransport } from "./services/field-transport/http-field-transport.ts";
import {
	type MessageChannel,
	MessageChannelService,
} from "./services/message-channel/message-channel.ts";
import { WebSocketMessageChannel } from "./services/message-channel/websocket-message-channel.ts";

type RpcShape = Record<
	string,
	{ readonly request: unknown; readonly response: unknown }
>;

const implementSubscription = Effect.fn("implementSubscription")(function* <
	Decoded,
>(field: FieldIdentifier, manifest: FieldManifest<Decoded>) {
	const messageChannel = yield* MessageChannelService;
	const latest = yield* SubscriptionRef.make<Option.Option<Decoded>>(
		Option.none(),
	);
	const rejection = yield* SubscriptionRef.make<
		Option.Option<FieldNotFound | FieldPermissionDenied>
	>(Option.none());
	let refcount = 0;

	const stream = yield* messageChannel.receive();

	yield* Effect.forkScoped(
		Stream.runForEach(stream, (msg) =>
			Match.value(msg).pipe(
				Match.when({ _tag: "publish", field }, (msg) =>
					manifest.decode(msg.value).pipe(
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
				Match.when({ _tag: "subscribe-rejected", field }, (msg) =>
					SubscriptionRef.set(
						rejection,
						Option.some(
							Match.value(msg.reason).pipe(
								Match.when(
									"not-found",
									() =>
										new FieldNotFound({
											namespace: field.namespace,
											name: field.name,
										}),
								),
								Match.when(
									"forbidden",
									() =>
										new FieldPermissionDenied({
											namespace: field.namespace,
											name: field.name,
										}),
								),
								Match.exhaustive,
							),
						),
					),
				),
				Match.orElse(() => Effect.void),
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

			yield* Effect.raceFirst(
				latest.changes.pipe(
					Stream.filterMap((value) => value),
					Stream.take(1),
					Stream.runDrain,
				),
				rejection.changes.pipe(
					Stream.filterMap((value) => value),
					Stream.runHead,
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.never,
							onSome: (error) => Effect.fail(error),
						}),
					),
				),
			);

			return latest.changes.pipe(Stream.filterMap((value) => value));
		});

	return subscribe;
});

const implementReplicant = Effect.fn("implementReplicant")(function* <Decoded>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
) {
	const transport = yield* FieldTransportService;
	const subscribe = yield* implementSubscription(
		{ type: "replicant", namespace, name },
		manifest,
	);

	const get = Effect.fn("get")(function* () {
		const current = yield* transport.readReplicant(namespace, name);
		return yield* manifest.decode(current);
	});

	const set = Effect.fn("set")(function* (value: Decoded) {
		const encoded = yield* manifest.encode(value);
		yield* transport.updateReplicant(namespace, name, encoded);
	});

	const update = Effect.fn("update")(function* (
		fn: (value: Decoded) => Decoded,
	) {
		const current = yield* get();
		const next = yield* Effect.try(() => fn(current));
		const encoded = yield* manifest.encode(next);
		yield* transport.updateReplicant(namespace, name, encoded);
	});

	return { get, set, update, subscribe };
});

type ReplicantFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof implementReplicant<Decoded>>
>;
export type ReplicantField<Decoded> = ApplyLambdaToObject<
	ReplicantFieldEffect<Decoded>,
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
	const transport = yield* FieldTransportService;
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

const implementTopic = Effect.fn("implementTopic")(function* <Decoded>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
) {
	const transport = yield* FieldTransportService;
	const messageChannel = yield* MessageChannelService;
	const field: FieldIdentifier = { type: "topic", namespace, name };
	let refcount = 0;

	const publish = Effect.fn("publish")(function* (value: Decoded) {
		const encoded = yield* manifest.encode(value);
		yield* transport.publishTopic(namespace, name, encoded);
	});

	const subscribe = () =>
		Effect.gen(function* () {
			const stream = yield* messageChannel.receive();
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
										`Failed to send unsubscribe for topic "${namespace}/${name}":`,
										error,
									),
								),
							);
					}),
			);

			return stream.pipe(
				Stream.filterMap((msg) =>
					msg._tag === "publish" && fieldIdentifierEquivalence(msg.field, field)
						? Option.some(msg.value)
						: Option.none(),
				),
				Stream.mapEffect((value) =>
					manifest.decode(value).pipe(
						Effect.map(Option.some),
						Effect.catchAll((error) =>
							Effect.logError(
								`Failed to decode published value for topic "${namespace}/${name}":`,
								error,
							).pipe(Effect.as(Option.none<Decoded>())),
						),
					),
				),
				Stream.filterMap((value) => value),
			);
		});

	return { publish, subscribe };
});

type TopicFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof implementTopic<Decoded>>
>;
export type TopicField<Decoded> = ApplyLambdaToObject<
	TopicFieldEffect<Decoded>,
	{
		publish: EffectToPromiseLambda;
		subscribe: StreamToSubscribeLambda;
	}
>;

const implementRpc = Effect.fn("implementRpc")(function* <Request, Response>(
	namespace: string,
	name: string,
	manifest: RpcFieldManifest<Request, Response>,
) {
	const transport = yield* FieldTransportService;

	const call = Effect.fn("call")(function* (request: Request) {
		const encoded = yield* manifest.request.encode(request);
		const response = yield* transport.callRpc(namespace, name, encoded);
		return yield* manifest.response.decode(response);
	});

	return { call };
});

type RpcFieldEffect<Request, Response> = Effect.Effect.Success<
	ReturnType<typeof implementRpc<Request, Response>>
>;
export type RpcField<Request, Response> = ApplyLambdaToObject<
	RpcFieldEffect<Request, Response>,
	{
		call: EffectToPromiseLambda;
	}
>;

interface FieldManifestLambda extends HKT.TypeLambda {
	readonly type: FieldManifest<this["Target"]>;
}

interface ReplicantFieldEffectLambda extends HKT.TypeLambda {
	readonly type: ReplicantFieldEffect<this["Target"]>;
}

interface ReplicantFieldPromiseLambda extends HKT.TypeLambda {
	readonly type: ReplicantField<this["Target"]>;
}

interface ComputedFieldEffectLambda extends HKT.TypeLambda {
	readonly type: ComputedFieldEffect<this["Target"]>;
}

interface ComputedFieldPromiseLambda extends HKT.TypeLambda {
	readonly type: ComputedField<this["Target"]>;
}

interface TopicFieldEffectLambda extends HKT.TypeLambda {
	readonly type: TopicFieldEffect<this["Target"]>;
}

interface TopicFieldPromiseLambda extends HKT.TypeLambda {
	readonly type: TopicField<this["Target"]>;
}

interface RpcFieldManifestLambda extends HKT.TypeLambda {
	readonly Target: { readonly request: unknown; readonly response: unknown };
	readonly type: RpcFieldManifest<
		this["Target"]["request"],
		this["Target"]["response"]
	>;
}

interface RpcFieldEffectLambda extends HKT.TypeLambda {
	readonly Target: { readonly request: unknown; readonly response: unknown };
	readonly type: RpcFieldEffect<
		this["Target"]["request"],
		this["Target"]["response"]
	>;
}

interface RpcFieldPromiseLambda extends HKT.TypeLambda {
	readonly Target: { readonly request: unknown; readonly response: unknown };
	readonly type: RpcField<
		this["Target"]["request"],
		this["Target"]["response"]
	>;
}

const buildNamespace = <
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
>(
	manifest: NamespaceManifest<Replicant, Computed, Topic, Rpc>,
) =>
	Effect.gen(function* () {
		const fields = yield* mapEffectValues<
			FieldManifestLambda,
			ReplicantFieldEffectLambda
		>()((codec, name) => implementReplicant(manifest.namespace, name, codec))(
			manifest.replicant,
		);
		const computedFields = yield* mapEffectValues<
			FieldManifestLambda,
			ComputedFieldEffectLambda
		>()((codec, name) => implementComputed(manifest.namespace, name, codec))(
			manifest.computed,
		);
		const topicFields = yield* mapEffectValues<
			FieldManifestLambda,
			TopicFieldEffectLambda
		>()((codec, name) => implementTopic(manifest.namespace, name, codec))(
			manifest.topic,
		);
		const rpcFields = yield* mapEffectValues<
			RpcFieldManifestLambda,
			RpcFieldEffectLambda
		>()((codec, name) => implementRpc(manifest.namespace, name, codec))(
			manifest.rpc,
		);
		return { fields, computedFields, topicFields, rpcFields };
	});

const buildHttpClient = Effect.fn("buildHttpClient")(function* () {
	const httpClient = yield* HttpApiClient.make(InternalApi);
	return {
		me: httpClient.Authentication.me,
		logout: httpClient.Authentication.logout,
	};
});

export const loadNamespaceEffect = Effect.fn("loadNamespaceEffect")(function* <
	Replicant extends Record<string, unknown> = {},
	Computed extends Record<string, unknown> = {},
	Topic extends Record<string, unknown> = {},
	Rpc extends RpcShape = {},
>(manifest: NamespaceManifest<Replicant, Computed, Topic, Rpc>) {
	const httpClient = yield* buildHttpClient();
	return yield* buildNamespace(manifest).pipe(
		Effect.map(({ fields, computedFields, topicFields, rpcFields }) => ({
			replicant: fields,
			computed: computedFields,
			topic: topicFields,
			rpc: rpcFields,
			httpClient,
		})),
	);
});

export interface LoadedNamespace<
	Replicant extends Record<string, unknown> = Record<string, unknown>,
	Computed extends Record<string, unknown> = Record<string, unknown>,
	Topic extends Record<string, unknown> = Record<string, unknown>,
	Rpc extends RpcShape = RpcShape,
> {
	readonly replicant: {
		readonly [K in keyof Replicant & string]: ReplicantField<Replicant[K]>;
	};
	readonly computed: {
		readonly [K in keyof Computed & string]: ComputedField<Computed[K]>;
	};
	readonly topic: {
		readonly [K in keyof Topic & string]: TopicField<Topic[K]>;
	};
	readonly rpc: {
		readonly [K in keyof Rpc & string]: RpcField<
			Rpc[K]["request"],
			Rpc[K]["response"]
		>;
	};
	httpClient: Effect.Effect.Success<
		ReturnType<typeof loadNamespaceEffect>
	>["httpClient"];
	readonly dispose: () => void;
	readonly [Symbol.dispose]: () => void;
}

export async function loadNamespace<
	Replicant extends Record<string, unknown> = {},
	Computed extends Record<string, unknown> = {},
	Topic extends Record<string, unknown> = {},
	Rpc extends RpcShape = {},
>(
	manifest: NamespaceManifest<Replicant, Computed, Topic, Rpc>,
	adapter?: {
		fieldTransport?:
			| (() => FieldTransport)
			| Effect.Effect<FieldTransport, never, never>;
		messageChannel?:
			| (() => MessageChannel)
			| Effect.Effect<MessageChannel, never, never>;
	},
): Promise<LoadedNamespace<Replicant, Computed, Topic, Rpc>> {
	const fieldTransport = adapter?.fieldTransport;
	const messageChannel = adapter?.messageChannel;

	const transportLayer = fieldTransport
		? Effect.isEffect(fieldTransport)
			? Layer.effect(FieldTransportService, fieldTransport)
			: Layer.sync(FieldTransportService, fieldTransport)
		: HttpFieldTransport;

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

	const {
		fields: effectFields,
		computedFields: effectComputedFields,
		topicFields: effectTopicFields,
		rpcFields: effectRpcFields,
	} = await runtime.runPromise(buildNamespace(manifest));

	const subscribeEffectToPromise =
		<Decoded, E>(
			subscribe: () => Effect.Effect<Stream.Stream<Decoded>, E, Scope.Scope>,
			name: string,
		) =>
		async (callback: (value: Decoded) => Promisable<void>) =>
			runtime.runPromise(
				Effect.gen(function* () {
					const scope = yield* Scope.make();
					const stream = yield* subscribe().pipe(
						Scope.extend(scope),
						Effect.onError(() => Scope.close(scope, Exit.void)),
					);
					yield* stream.pipe(
						Stream.runForEach((value) =>
							Effect.tryPromise(async () => callback(value)).pipe(
								Effect.catchAll((error) =>
									Effect.logError(
										`Replicant subscription handler for "${manifest.namespace}/${name}" threw`,
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

	const replicant = mapValues<
		ReplicantFieldEffectLambda,
		ReplicantFieldPromiseLambda
	>((field, name) => ({
		get: () => runtime.runPromise(field.get()),
		set: (value) => runtime.runPromise(field.set(value)),
		update: (fn) => runtime.runPromise(field.update(fn)),
		subscribe: subscribeEffectToPromise(field.subscribe, name),
	}))(effectFields);

	const computed = mapValues<
		ComputedFieldEffectLambda,
		ComputedFieldPromiseLambda
	>((field, name) => ({
		get: () => runtime.runPromise(field.get()),
		subscribe: subscribeEffectToPromise(field.subscribe, name),
	}))(effectComputedFields);

	const topic = mapValues<TopicFieldEffectLambda, TopicFieldPromiseLambda>(
		(field, name) => ({
			publish: (value) => runtime.runPromise(field.publish(value)),
			subscribe: subscribeEffectToPromise(field.subscribe, name),
		}),
	)(effectTopicFields);

	const rpc = mapValues<RpcFieldEffectLambda, RpcFieldPromiseLambda>(
		(field) => ({
			call: (request) => runtime.runPromise(field.call(request)),
		}),
	)(effectRpcFields);

	return {
		replicant: replicant,
		computed,
		topic,
		rpc,
		httpClient: runtime.runSync(buildHttpClient()),
		dispose: runtime.dispose,
		[Symbol.dispose]: () => runtime.dispose(),
	};
}
