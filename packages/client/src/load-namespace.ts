import { FetchHttpClient, Path } from "@effect/platform";
import type {
	NamespaceManifest,
	FieldManifest,
	RpcFieldManifest,
} from "@nodecg/core";
import {
	mapEffectValues,
	mapValues,
	type EffectToPromiseLambda,
	type StreamToSubscribeLambda,
	type ApplyLambdaToObject,
} from "@nodecg/internal/utils";
import { effect } from "@preact/signals-core";
import {
	Deferred,
	Effect,
	Exit,
	type HKT,
	Layer,
	Mailbox,
	ManagedRuntime,
	Scope,
	Stream,
} from "effect";
import type { Promisable } from "type-fest";

import { type FieldSource, fieldSource } from "./derive.ts";
import {
	type FieldCell,
	FieldCellsService,
	type FieldFailure,
} from "./field-cells.ts";
import { isFailure, isReady, matchLoadable } from "./loadable.ts";
import {
	FieldTransportService,
	type FieldTransport,
} from "./services/field-transport/field-transport.ts";
import { httpFieldTransport } from "./services/field-transport/http-field-transport.ts";
import {
	type MessageChannel,
	MessageChannelService,
} from "./services/message-channel/message-channel.ts";
import { webSocketMessageChannel } from "./services/message-channel/websocket-message-channel.ts";

type RpcShape = Record<
	string,
	{ readonly request: unknown; readonly response: unknown }
>;

const subscribeCell = Effect.fn(function* <Decoded>(cell: FieldCell<Decoded>) {
	const mailbox = yield* Mailbox.make<Decoded>();
	const ready = yield* Deferred.make<void, FieldFailure>();
	yield* Effect.acquireRelease(
		Effect.sync(() =>
			effect(() => {
				const value = cell.signal.value;
				if (isReady(value)) {
					mailbox.unsafeOffer(value.value);
					Deferred.unsafeDone(ready, Effect.void);
				} else if (isFailure(value)) {
					Deferred.unsafeDone(ready, Effect.fail(value.error));
				}
			}),
		),
		(dispose) => Effect.sync(dispose),
	);
	yield* Deferred.await(ready);
	return Mailbox.toStream(mailbox);
});

// Topic doesn't have to wait for first value
const subscribeTopicCell = Effect.fn(function* <Decoded>(
	cell: FieldCell<Decoded>,
) {
	const mailbox = yield* Mailbox.make<Decoded>();
	let initial = true;
	yield* Effect.acquireRelease(
		Effect.sync(() =>
			effect(() => {
				const value = cell.signal.value;
				if (initial) {
					initial = false;
					return;
				}
				if (isReady(value)) {
					mailbox.unsafeOffer(value.value);
				}
			}),
		),
		(dispose) => Effect.sync(dispose),
	);
	return Mailbox.toStream(mailbox);
});

const implementReplicant = Effect.fn("implementReplicant")(function* <Decoded>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
) {
	const transport = yield* FieldTransportService;
	const cells = yield* FieldCellsService;
	const cell = cells.replicant(namespace, name, manifest);

	const get = Effect.fn("get")(function* () {
		return yield* matchLoadable(cell.peek(), {
			Ready: ({ value }) => Effect.succeed(value),
			Failure: ({ error }) => Effect.fail(error),
			Pending: () =>
				transport
					.readReplicant(namespace, name)
					.pipe(Effect.flatMap(manifest.decode)),
		});
	});

	const set = Effect.fn("set")(function* (value: Decoded) {
		const encoded = yield* manifest.encode(value);
		yield* transport.updateReplicant(namespace, name, encoded);
		cell.reflect(value);
	});

	const update = Effect.fn("update")(function* (
		fn: (value: Decoded) => Decoded,
	) {
		const current = yield* get();
		const next = yield* Effect.try(() => fn(current));
		const encoded = yield* manifest.encode(next);
		yield* transport.updateReplicant(namespace, name, encoded);
		cell.reflect(next);
	});

	const subscribe = () => subscribeCell(cell);

	return { get, set, update, subscribe, [fieldSource]: cell.signal };
});

type ReplicantFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof implementReplicant<Decoded>>
>;
export type ReplicantField<Decoded> = ApplyLambdaToObject<
	Omit<ReplicantFieldEffect<Decoded>, typeof fieldSource>,
	{
		get: EffectToPromiseLambda;
		set: EffectToPromiseLambda;
		update: EffectToPromiseLambda;
		subscribe: StreamToSubscribeLambda;
	}
> &
	FieldSource<Decoded>;

const implementComputed = Effect.fn("implementComputed")(function* <Decoded>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
) {
	const transport = yield* FieldTransportService;
	const cells = yield* FieldCellsService;
	const cell = cells.computed(namespace, name, manifest);

	const get = Effect.fn("get")(function* () {
		return yield* matchLoadable(cell.peek(), {
			Ready: ({ value }) => Effect.succeed(value),
			Failure: ({ error }) => Effect.fail(error),
			Pending: () =>
				transport
					.readComputed(namespace, name)
					.pipe(Effect.flatMap(manifest.decode)),
		});
	});

	const subscribe = () => subscribeCell(cell);

	return { get, subscribe, [fieldSource]: cell.signal };
});

type ComputedFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof implementComputed<Decoded>>
>;
export type ComputedField<Decoded> = ApplyLambdaToObject<
	Omit<ComputedFieldEffect<Decoded>, typeof fieldSource>,
	{
		get: EffectToPromiseLambda;
		subscribe: StreamToSubscribeLambda;
	}
> &
	FieldSource<Decoded>;

const implementTopic = Effect.fn("implementTopic")(function* <Decoded>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
) {
	const transport = yield* FieldTransportService;
	const cells = yield* FieldCellsService;
	const cell = cells.topic(namespace, name, manifest);

	const publish = Effect.fn("publish")(function* (value: Decoded) {
		const encoded = yield* manifest.encode(value);
		yield* transport.publishTopic(namespace, name, encoded);
	});

	const subscribe = () => subscribeTopicCell(cell);

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
	Layer.build(FieldCellsService.Default).pipe(
		Effect.flatMap((context) =>
			Effect.gen(function* () {
				const fields = yield* mapEffectValues<
					FieldManifestLambda,
					ReplicantFieldEffectLambda
				>()((codec, name) =>
					implementReplicant(manifest.namespace, name, codec),
				)(manifest.replicant);
				const computedFields = yield* mapEffectValues<
					FieldManifestLambda,
					ComputedFieldEffectLambda
				>()((codec, name) =>
					implementComputed(manifest.namespace, name, codec),
				)(manifest.computed);
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
			}).pipe(Effect.provide(context)),
		),
	);

export const loadNamespaceEffect = Effect.fn("loadNamespaceEffect")(function* <
	Replicant extends Record<string, unknown> = {},
	Computed extends Record<string, unknown> = {},
	Topic extends Record<string, unknown> = {},
	Rpc extends RpcShape = {},
>(manifest: NamespaceManifest<Replicant, Computed, Topic, Rpc>) {
	return yield* buildNamespace(manifest).pipe(
		Effect.map(({ fields, computedFields, topicFields, rpcFields }) => ({
			replicant: fields,
			computed: computedFields,
			topic: topicFields,
			rpc: rpcFields,
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
	options?: {
		baseUrl?: string;
		fieldTransport?:
			| (() => FieldTransport)
			| Effect.Effect<FieldTransport, never, never>;
		messageChannel?:
			| (() => MessageChannel)
			| Effect.Effect<MessageChannel, never, never>;
	},
): Promise<LoadedNamespace<Replicant, Computed, Topic, Rpc>> {
	const baseUrl = options?.baseUrl;
	const fieldTransport = options?.fieldTransport;
	const messageChannel = options?.messageChannel;

	const transportLayer = fieldTransport
		? Effect.isEffect(fieldTransport)
			? Layer.effect(FieldTransportService, fieldTransport)
			: Layer.sync(FieldTransportService, fieldTransport)
		: httpFieldTransport(baseUrl);

	const messageChannelLayer = messageChannel
		? Effect.isEffect(messageChannel)
			? Layer.effect(MessageChannelService, messageChannel)
			: Layer.sync(MessageChannelService, messageChannel)
		: webSocketMessageChannel(baseUrl);

	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			transportLayer,
			messageChannelLayer,
			FetchHttpClient.layer,
			Layer.scope,
		).pipe(Layer.provide(Path.layer)),
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
										`Subscription handler for "${manifest.namespace}/${name}" threw`,
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
		[fieldSource]: field[fieldSource],
	}))(effectFields);

	const computed = mapValues<
		ComputedFieldEffectLambda,
		ComputedFieldPromiseLambda
	>((field, name) => ({
		get: () => runtime.runPromise(field.get()),
		subscribe: subscribeEffectToPromise(field.subscribe, name),
		[fieldSource]: field[fieldSource],
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
		dispose: runtime.dispose,
		[Symbol.dispose]: () => runtime.dispose(),
	};
}
