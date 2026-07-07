import type {
	NamespaceManifest,
	FieldManifest,
	RpcFieldManifest,
} from "@nodecg/core";
import { CurrentIdentity } from "@nodecg/internal";
import {
	mapValues,
	mapEffectValues,
	mergeRecords,
	zipEffectValues,
	toError,
	type EffectToPromiseLambda,
	type EffectToSyncLambda,
	type StreamToSubscribeLambda,
	type IdentityLambda,
	type ApplyLambdaToObject,
} from "@nodecg/internal/utils";
import {
	Data,
	Effect,
	Exit,
	type HKT,
	Layer,
	ManagedRuntime,
	Option,
	Scope,
	Stream,
} from "effect";
import type { JsonValue, Promisable } from "type-fest";

import { InMemoryStateStorage } from "./services/state-storage/in-memory-state-storage.ts";
import {
	StateNotFound,
	StateStorageService,
	type StateStorage,
} from "./services/state-storage/state-storage.ts";
import { InMemoryTopicBroker } from "./services/topic-broker/in-memory-topic-broker.ts";
import { TopicBrokerService } from "./services/topic-broker/topic-broker.ts";

export const fieldInternal = Symbol("fieldInternal");

export type FrontendConfig = {
	readonly dir: string | URL;
	readonly vite?: { readonly root: string | URL; readonly spa?: boolean };
};

export class StateUpdateFnError extends Data.TaggedError("StateUpdateFnError")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Update function for state "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

export class ComputedComputeError extends Data.TaggedError(
	"ComputedComputeError",
)<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Computing computed field "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

export class PermissionDenied extends Data.TaggedError("PermissionDenied")<{
	namespace: string;
	name: string;
	operation: "read" | "write";
}> {
	override readonly message = `Permission denied to ${this.operation} "${this.name}" in "${this.namespace}"`;
}

export class RpcHandlerFailure extends Data.TaggedError("RpcHandlerFailure")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `RPC handler for "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

export type SeedState<State extends Record<string, unknown>> = {
	readonly [K in keyof State & string]: () => Promisable<State[K]>;
};

type SourceSnapshot<State extends Record<string, unknown>> = {
	readonly [K in keyof State & string]: State[K];
};

export type ImplementComputed<
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
> = {
	readonly [K in keyof Computed & string]: (
		sources: SourceSnapshot<State>,
	) => Computed[K];
};

export type RpcShape = Record<
	string,
	{ readonly request: unknown; readonly response: unknown }
>;

export type ImplementRpc<Rpc extends RpcShape> = {
	readonly [K in keyof Rpc & string]: (
		request: Rpc[K]["request"],
	) => Promisable<Rpc[K]["response"]>;
};

type NamespaceOptions<
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Rpc extends RpcShape,
> = {
	readonly seedState?: SeedState<State>;
	readonly implementComputed?: ImplementComputed<State, Computed>;
	readonly implementRpc?: ImplementRpc<Rpc>;
};

export type RequiredOptions<
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Rpc extends RpcShape,
> = ([keyof State] extends [never]
	? {}
	: { readonly seedState: SeedState<State> }) &
	([keyof Computed] extends [never]
		? {}
		: { readonly implementComputed: ImplementComputed<State, Computed> }) &
	([keyof Rpc] extends [never]
		? {}
		: { readonly implementRpc: ImplementRpc<Rpc> });

// TODO: support automatic migrations
const migrationDie = () =>
	new Error(
		"Currently stored state value failed schema validation. Migration is not supported yet.",
	);

const implementState = Effect.fn("implementState")(function* <Decoded>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
) {
	const storage = yield* StateStorageService;

	const get = Effect.fn("get")(function* () {
		const current = yield* Option.match(storage.read(namespace, name), {
			onNone: () => new StateNotFound({ namespace, name }),
			onSome: Effect.succeed,
		});
		return yield* manifest.decode(current).pipe(Effect.orDieWith(migrationDie));
	});

	const getEncodedNoAuth = Effect.fn("getEncodedNoAuth")(function* () {
		const encoded = yield* Option.match(storage.read(namespace, name), {
			onNone: () => new StateNotFound({ namespace, name }),
			onSome: Effect.succeed,
		});
		yield* manifest.decode(encoded).pipe(Effect.orDieWith(migrationDie));
		return encoded;
	});

	const getEncoded = Effect.fn("getEncoded")(function* () {
		const identity = yield* CurrentIdentity;
		if (!manifest.permission.canRead(identity)) {
			return yield* new PermissionDenied({
				namespace,
				name,
				operation: "read",
			});
		}
		return yield* getEncodedNoAuth();
	});

	const set = Effect.fn("set")(function* (value: Decoded) {
		const encoded = yield* manifest.encode(value);
		yield* storage.update(namespace, name, encoded);
	});

	const setEncoded = Effect.fn("setEncoded")(function* (value: JsonValue) {
		const identity = yield* CurrentIdentity;
		if (!manifest.permission.canWrite(identity)) {
			return yield* new PermissionDenied({
				namespace,
				name,
				operation: "write",
			});
		}
		yield* manifest.decode(value); // Only for validation
		return yield* storage.update(namespace, name, value);
	});

	const update = Effect.fn("update")(function* (
		fn: (value: Decoded, abortSignal: AbortSignal) => Promisable<Decoded>,
	) {
		const current = yield* get();
		const next = yield* Effect.tryPromise({
			try: async (abortSignal) => fn(current, abortSignal),
			catch: (error) =>
				new StateUpdateFnError({ namespace, name, cause: toError(error) }),
		});
		const encoded = yield* manifest.encode(next);
		yield* storage.update(namespace, name, encoded);
	});

	const subscribeEncoded = Effect.fn("subscribeEncoded")(function* () {
		const changesStream = yield* storage.subscribe();
		const stateValueStream = changesStream.pipe(
			Stream.filter(
				(change) => change.namespace === namespace && change.name === name,
			),
			Stream.map((change) => change.value),
		);
		const initialValue = yield* getEncodedNoAuth();
		return Stream.concat(Stream.succeed(initialValue), stateValueStream);
	});

	const subscribe = Effect.fn("subscribe")(function* () {
		const stream = yield* subscribeEncoded();
		return stream.pipe(
			Stream.flatMap((value) =>
				manifest.decode(value).pipe(Effect.orDieWith(migrationDie)),
			),
		);
	});

	return {
		get,
		set,
		update,
		validate: manifest.encode,
		subscribe,
		[fieldInternal]: {
			get,
			set,
			update,
			validate: manifest.encode,
			subscribe,
			getEncodedNoAuth,
			getEncoded,
			setEncoded,
			subscribeEncoded,
			permission: manifest.permission,
		},
	};
});

type StateFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof implementState<Decoded>>
>;
export type StateField<Decoded> = ApplyLambdaToObject<
	StateFieldEffect<Decoded>,
	{
		get: EffectToSyncLambda;
		set: EffectToSyncLambda;
		update: EffectToPromiseLambda;
		validate: EffectToPromiseLambda;
		subscribe: StreamToSubscribeLambda;
		[fieldInternal]: IdentityLambda;
	}
>;

const implementComputed = Effect.fn("implementComputed")(function* <
	Sources,
	Decoded,
>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
	compute: (sources: Sources) => Decoded,
	readSnapshot: Effect.Effect<Sources, StateNotFound>,
) {
	const storage = yield* StateStorageService;

	const get = Effect.fn("compute")(function* () {
		const sources = yield* readSnapshot;
		return yield* Effect.try({
			try: () => compute(sources),
			catch: (error) =>
				new ComputedComputeError({ namespace, name, cause: toError(error) }),
		});
	});

	const getEncodedNoAuth = Effect.fn("readEncoded")(function* () {
		const value = yield* get();
		return yield* manifest.encode(value);
	});

	const getEncoded = Effect.fn("getEncoded")(function* () {
		const identity = yield* CurrentIdentity;
		if (!manifest.permission.canRead(identity)) {
			return yield* new PermissionDenied({
				namespace,
				name,
				operation: "read",
			});
		}
		return yield* getEncodedNoAuth();
	});

	const subscribeEncoded = Effect.fn("subscribeEncoded")(function* () {
		const changesStream = yield* storage.subscribe();
		const recompute = getEncodedNoAuth().pipe(
			Effect.map((encoded) =>
				Option.some({ encoded, key: JSON.stringify(encoded) }),
			),
			Effect.catchAll((error) =>
				Effect.logError(
					`Failed to compute state "${namespace}/${name}"`,
					error,
				).pipe(Effect.as(Option.none<{ encoded: JsonValue; key: string }>())),
			),
		);
		const seed = yield* recompute;
		return Stream.concat(
			Stream.fromIterable(Option.isSome(seed) ? [seed.value] : []),
			changesStream.pipe(
				Stream.filter((change) => change.namespace === namespace),
				Stream.mapEffect(() => recompute),
				Stream.filterMap((option) => option),
			),
		).pipe(
			Stream.changesWith((a, b) => a.key === b.key),
			Stream.map((item) => item.encoded),
		);
	});

	const subscribe = Effect.fn("subscribe")(function* () {
		const stream = yield* subscribeEncoded();
		return stream.pipe(
			Stream.mapEffect((value) =>
				manifest.decode(value).pipe(Effect.orDieWith(migrationDie)),
			),
		);
	});

	return {
		get,
		subscribe,
		[fieldInternal]: {
			get,
			subscribe,
			getEncodedNoAuth,
			getEncoded,
			subscribeEncoded,
			permission: manifest.permission,
		},
	};
});

type ComputedFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof implementComputed<unknown, Decoded>>
>;
export type ComputedField<Decoded> = ApplyLambdaToObject<
	ComputedFieldEffect<Decoded>,
	{
		get: EffectToSyncLambda;
		subscribe: StreamToSubscribeLambda;
		[fieldInternal]: IdentityLambda;
	}
>;

const implementTopic = Effect.fn("implementTopic")(function* <Decoded>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
) {
	const broker = yield* TopicBrokerService;

	const publish = Effect.fn("publish")(function* (value: Decoded) {
		const encoded = yield* manifest.encode(value);
		yield* broker.publish(namespace, name, encoded);
	});

	const subscribeEncoded = Effect.fn("subscribeEncoded")(function* () {
		const stream = yield* broker.subscribe();
		return stream.pipe(
			Stream.filter(
				(message) => message.namespace === namespace && message.name === name,
			),
			Stream.map((message) => message.value),
		);
	});

	const subscribe = Effect.fn("subscribe")(function* () {
		const stream = yield* subscribeEncoded();
		return stream.pipe(
			Stream.mapEffect((value) => manifest.decode(value).pipe(Effect.orDie)),
		);
	});

	const publishEncoded = Effect.fn("publishEncoded")(function* (
		value: JsonValue,
	) {
		const identity = yield* CurrentIdentity;
		if (!manifest.permission.canWrite(identity)) {
			return yield* new PermissionDenied({
				namespace,
				name,
				operation: "write",
			});
		}
		yield* manifest.decode(value); // Only for validation
		return yield* broker.publish(namespace, name, value);
	});

	return {
		publish,
		subscribe,
		[fieldInternal]: {
			publish,
			subscribe,
			subscribeEncoded,
			publishEncoded,
			permission: manifest.permission,
		},
	};
});

type TopicFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof implementTopic<Decoded>>
>;
export type TopicField<Decoded> = ApplyLambdaToObject<
	TopicFieldEffect<Decoded>,
	{
		publish: EffectToPromiseLambda;
		subscribe: StreamToSubscribeLambda;
		[fieldInternal]: IdentityLambda;
	}
>;

const implementRpc = <Request, Response>(
	namespace: string,
	name: string,
	manifest: RpcFieldManifest<Request, Response>,
	handler: (request: Request) => Promisable<Response>,
) => {
	const callEncoded = Effect.fn("callEncoded")(function* (payload: JsonValue) {
		const identity = yield* CurrentIdentity;
		if (!manifest.permission.canWrite(identity)) {
			return yield* new PermissionDenied({
				namespace,
				name,
				operation: "write",
			});
		}
		const request = yield* manifest.request.decode(payload);
		const response = yield* Effect.tryPromise({
			try: async () => handler(request),
			catch: (error) =>
				new RpcHandlerFailure({ namespace, name, cause: toError(error) }),
		});
		return yield* manifest.response.encode(response);
	});

	return Effect.succeed({
		[fieldInternal]: {
			callEncoded,
			permission: manifest.permission,
		},
	});
};

type RpcFieldEffect<Request, Response> = Effect.Effect.Success<
	ReturnType<typeof implementRpc<Request, Response>>
>;
export type RpcField<Request, Response> = ApplyLambdaToObject<
	RpcFieldEffect<Request, Response>,
	{
		[fieldInternal]: IdentityLambda;
	}
>;

interface FieldManifestLambda extends HKT.TypeLambda {
	readonly type: FieldManifest<this["Target"]>;
}

interface DecodedLambda extends HKT.TypeLambda {
	readonly type: this["Target"];
}

interface ComputeFnLambda extends HKT.TypeLambda {
	readonly type: (sources: this["In"]) => this["Target"];
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

interface RpcHandlerLambda extends HKT.TypeLambda {
	readonly Target: { readonly request: unknown; readonly response: unknown };
	readonly type: (
		request: this["Target"]["request"],
	) => Promisable<this["Target"]["response"]>;
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

export const namespaceMetadataKey = Symbol("namespaceMetadataKey");

const buildNamespace = <
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
>(
	manifest: NamespaceManifest<State, Computed, Topic, Rpc>,
	options:
		| (NamespaceOptions<State, Computed, Rpc> & { readonly storage?: unknown })
		| undefined,
) => {
	const seedState = options?.seedState;
	const computeFns = options?.implementComputed;
	const rpcHandlers = options?.implementRpc;
	return Effect.gen(function* () {
		const storage = yield* StateStorageService;

		yield* Effect.all(
			Object.entries(manifest.state).map(
				([name, codec]: [string, FieldManifest<unknown>]) => {
					const seed = Effect.gen(function* () {
						const thunk = seedState?.[name];
						if (typeof thunk === "undefined") {
							return yield* Effect.die(
								new Error(`Missing seed value for state "${name}"`),
							);
						}
						const value = yield* Effect.tryPromise(async () => thunk());
						const encoded = yield* codec.encode(value);
						yield* storage.create(manifest.namespace, name, encoded);
					});
					return Option.isNone(storage.read(manifest.namespace, name))
						? seed
						: Effect.void;
				},
			),
			{ concurrency: "unbounded" },
		);

		const stateFields = yield* mapEffectValues<
			FieldManifestLambda,
			StateFieldEffectLambda
		>()((codec, name) => implementState(manifest.namespace, name, codec))(
			manifest.state,
		);

		const readSnapshot: Effect.Effect<
			SourceSnapshot<State>,
			StateNotFound
		> = mapEffectValues<FieldManifestLambda, DecodedLambda>()((codec, name) =>
			Effect.gen(function* () {
				const encoded = yield* Option.match(
					storage.read(manifest.namespace, name),
					{
						onNone: () =>
							new StateNotFound({ namespace: manifest.namespace, name }),
						onSome: Effect.succeed,
					},
				);
				return yield* codec
					.decode(encoded)
					.pipe(Effect.orDieWith(migrationDie));
			}),
		)(manifest.state);

		const computedFields = yield* zipEffectValues<
			FieldManifestLambda,
			ComputeFnLambda,
			ComputedFieldEffectLambda,
			SourceSnapshot<State>,
			Computed
		>()(manifest.computed, computeFns, (codec, compute, name) =>
			implementComputed(manifest.namespace, name, codec, compute, readSnapshot),
		);

		// Eager compute at load and fail-fast validation
		yield* Effect.forEach(
			Object.values(computedFields),
			(field) => field[fieldInternal].getEncodedNoAuth(),
			{ concurrency: "unbounded", discard: true },
		);

		const topicFields = yield* mapEffectValues<
			FieldManifestLambda,
			TopicFieldEffectLambda
		>()((codec, name) => implementTopic(manifest.namespace, name, codec))(
			manifest.topic,
		);

		const rpcFields = yield* zipEffectValues<
			RpcFieldManifestLambda,
			RpcHandlerLambda,
			RpcFieldEffectLambda,
			unknown,
			Rpc
		>()(manifest.rpc, rpcHandlers, (codec, handler, name) =>
			implementRpc(manifest.namespace, name, codec, handler),
		);

		return { stateFields, computedFields, topicFields, rpcFields };
	});
};

export function loadNamespaceEffect<
	State extends Record<string, unknown> = {},
	Computed extends Record<string, unknown> = {},
	Topic extends Record<string, unknown> = {},
	Rpc extends RpcShape = {},
>(
	manifest: NamespaceManifest<State, Computed, Topic, Rpc>,
	...rest: [keyof State | keyof Computed | keyof Rpc] extends [never]
		? []
		: [options: RequiredOptions<State, Computed, Rpc>]
) {
	const [options] = rest;
	return buildNamespace(manifest, options).pipe(
		Effect.map(({ stateFields, computedFields, topicFields, rpcFields }) => ({
			state: stateFields,
			computed: computedFields,
			topic: topicFields,
			rpc: rpcFields,
			[namespaceMetadataKey]: { namespace: manifest.namespace },
		})),
	);
}

type StorageOption = StateStorage | Effect.Effect<StateStorage, never, never>;

async function loadNamespacePromise<
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
>(
	manifest: NamespaceManifest<State, Computed, Topic, Rpc>,
	options:
		| (NamespaceOptions<State, Computed, Rpc> & {
				readonly storage?: StorageOption;
				readonly frontend?: FrontendConfig;
		  })
		| undefined,
): Promise<LoadedNamespace<State, Computed, Topic, Rpc>> {
	const storage = options?.storage;
	const storageLayer = storage
		? Effect.isEffect(storage)
			? Layer.effect(StateStorageService, storage)
			: Layer.succeed(StateStorageService, storage)
		: InMemoryStateStorage;
	const runtime = ManagedRuntime.make(
		Layer.merge(storageLayer, InMemoryTopicBroker),
	);

	const {
		stateFields: effectStateFields,
		computedFields: effectComputedFields,
		topicFields: effectTopicFields,
		rpcFields: effectRpcFields,
	} = await runtime.runPromise(buildNamespace(manifest, options));

	const subscribeAdapter =
		<Decoded, E>(
			subscribe: () => Effect.Effect<Stream.Stream<Decoded>, E, Scope.Scope>,
			name: string,
		) =>
		async (handler: (value: Decoded) => Promisable<void>) => {
			return runtime.runPromise(
				Effect.gen(function* () {
					const scope = yield* Scope.make();
					const subscription = yield* subscribe().pipe(Scope.extend(scope));
					yield* Effect.forkIn(
						Stream.runForEach(subscription, (value) =>
							Effect.tryPromise(async () => handler(value)).pipe(
								Effect.catchAll((error) =>
									Effect.logError(
										`State subscription handler for "${manifest.namespace}/${name}" threw`,
										error,
									),
								),
							),
						).pipe(Effect.ensureErrorType<never>()),
						scope,
					);
					return async () => {
						await runtime.runPromise(Scope.close(scope, Exit.void));
					};
				}),
			);
		};

	const state = mapValues<StateFieldEffectLambda, StateFieldPromiseLambda>(
		(field, name) => ({
			get: () => runtime.runSync(field.get()),
			set: (value) => runtime.runSync(field.set(value)),
			update: (fn) => runtime.runPromise(field.update(fn)),
			validate: (value) => runtime.runPromise(field.validate(value)),
			subscribe: subscribeAdapter(field.subscribe, name),
			[fieldInternal]: field[fieldInternal],
		}),
	)(effectStateFields);

	const computed = mapValues<
		ComputedFieldEffectLambda,
		ComputedFieldPromiseLambda
	>((field, name) => ({
		get: () => runtime.runSync(field.get()),
		subscribe: subscribeAdapter(field.subscribe, name),
		[fieldInternal]: field[fieldInternal],
	}))(effectComputedFields);

	const topic = mapValues<TopicFieldEffectLambda, TopicFieldPromiseLambda>(
		(field, name) => ({
			publish: (value) => runtime.runPromise(field.publish(value)),
			subscribe: subscribeAdapter(field.subscribe, name),
			[fieldInternal]: field[fieldInternal],
		}),
	)(effectTopicFields);

	const rpc = mapValues<RpcFieldEffectLambda, RpcFieldPromiseLambda>(
		(field) => ({
			[fieldInternal]: field[fieldInternal],
		}),
	)(effectRpcFields);

	return {
		state,
		computed,
		topic,
		rpc,
		[namespaceMetadataKey]: {
			namespace: manifest.namespace,
			frontend: options?.frontend,
		},
	};
}

export function loadNamespace<
	State extends Record<string, unknown> = {},
	Computed extends Record<string, unknown> = {},
	Topic extends Record<string, unknown> = {},
	Rpc extends RpcShape = {},
>(
	manifest: NamespaceManifest<State, Computed, Topic, Rpc>,
	...rest: [keyof State | keyof Computed | keyof Rpc] extends [never]
		? [
				options?: {
					// TODO: inject storage from loadNodeCG
					readonly storage?: StorageOption;
					readonly frontend?: FrontendConfig;
				},
			]
		: [
				options: RequiredOptions<State, Computed, Rpc> & {
					// TODO: inject storage from loadNodeCG
					readonly storage?: StorageOption;
					readonly frontend?: FrontendConfig;
				},
			]
) {
	return loadNamespacePromise(manifest, rest[0]);
}

interface ImplementedNamespace<
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
> {
	readonly manifest: NamespaceManifest<State, Computed, Topic, Rpc>;
	readonly impl:
		| (NamespaceOptions<State, Computed, Rpc> & {
				readonly frontend?: FrontendConfig;
		  })
		| undefined;
	// TODO: inject storage from loadNodeCG
	readonly load: (
		storage?: StorageOption,
	) => ReturnType<typeof loadNamespacePromise<State, Computed, Topic, Rpc>>;
}

export function implementNamespace<
	State extends Record<string, unknown> = {},
	Computed extends Record<string, unknown> = {},
	Topic extends Record<string, unknown> = {},
	Rpc extends RpcShape = {},
>(
	manifest: NamespaceManifest<State, Computed, Topic, Rpc>,
	...rest: [keyof State | keyof Computed | keyof Rpc] extends [never]
		? [options?: { readonly frontend?: FrontendConfig }]
		: [
				impl: RequiredOptions<State, Computed, Rpc> & {
					readonly frontend?: FrontendConfig;
				},
			]
): ImplementedNamespace<State, Computed, Topic, Rpc> {
	const [impl] = rest;
	return {
		manifest,
		impl,
		load: (storage) => loadNamespacePromise(manifest, { ...impl, storage }),
	};
}

type RelaxCovered<O, Covered extends PropertyKey> = Omit<O, Covered> &
	Partial<Pick<O, Extract<keyof O, Covered>>>;

type ExtensionSupplement<
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Rpc extends RpcShape,
	CoveredState extends PropertyKey,
	CoveredComputed extends PropertyKey,
	CoveredRpc extends PropertyKey,
> = ([keyof Omit<State, CoveredState>] extends [never]
	? { readonly seedState?: RelaxCovered<SeedState<State>, CoveredState> }
	: { readonly seedState: RelaxCovered<SeedState<State>, CoveredState> }) &
	([keyof Omit<Computed, CoveredComputed>] extends [never]
		? {
				readonly implementComputed?: RelaxCovered<
					ImplementComputed<State, Computed>,
					CoveredComputed
				>;
			}
		: {
				readonly implementComputed: RelaxCovered<
					ImplementComputed<State, Computed>,
					CoveredComputed
				>;
			}) &
	([keyof Omit<Rpc, CoveredRpc>] extends [never]
		? {
				readonly implementRpc?: RelaxCovered<ImplementRpc<Rpc>, CoveredRpc>;
			}
		: {
				readonly implementRpc: RelaxCovered<ImplementRpc<Rpc>, CoveredRpc>;
			});

export function loadExtendedNamespace<
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
	const Base extends ImplementedNamespace<any, any, any, any>,
>(
	manifest: NamespaceManifest<State, Computed, Topic, Rpc>,
	implemented: Base,
	additional: ExtensionSupplement<
		State,
		Computed,
		Rpc,
		keyof Base["manifest"]["state"] & string,
		keyof Base["manifest"]["computed"] & string,
		keyof Base["manifest"]["rpc"] & string
	>,
	options?: {
		readonly storage?: StorageOption;
		readonly frontend?: FrontendConfig;
	},
) {
	const merged: NamespaceOptions<State, Computed, Rpc> = {
		seedState: mergeRecords<SeedState<State>>(
			implemented.impl?.seedState,
			additional.seedState,
		),
		implementComputed: mergeRecords<ImplementComputed<State, Computed>>(
			implemented.impl?.implementComputed,
			additional.implementComputed,
		),
		implementRpc: mergeRecords<ImplementRpc<Rpc>>(
			implemented.impl?.implementRpc,
			additional.implementRpc,
		),
	};
	return loadNamespacePromise(manifest, {
		...merged,
		storage: options?.storage,
		frontend: options?.frontend ?? implemented.impl?.frontend,
	});
}

export interface LoadedNamespace<
	State extends Record<string, unknown> = Record<string, unknown>,
	Computed extends Record<string, unknown> = Record<string, unknown>,
	Topic extends Record<string, unknown> = Record<string, unknown>,
	Rpc extends RpcShape = RpcShape,
> {
	readonly [namespaceMetadataKey]: {
		readonly namespace: string;
		readonly frontend?: FrontendConfig;
	};
	readonly state: {
		readonly [K in keyof State & string]: StateField<State[K]>;
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
}
