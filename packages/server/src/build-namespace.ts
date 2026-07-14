import type {
	NamespaceManifest,
	FieldManifest,
	RpcFieldManifest,
} from "@nodecg/core";
import { CurrentIdentity } from "@nodecg/internal";
import {
	mapValues,
	mapEffectValues,
	zipEffectValues,
	toError,
} from "@nodecg/internal/utils";
import { Data, Effect, type HKT, Option, Runtime, Stream } from "effect";
import type { JsonValue, Promisable } from "type-fest";

import type {
	NamespaceOptions,
	RpcComputedAccessor,
	RpcContext,
	RpcReplicantAccessor,
	RpcShape,
	RpcTopicAccessor,
	SourceSnapshot,
} from "./implement-namespace.ts";
import {
	ReplicantNotFound,
	ReplicantStorageService,
} from "./services/replicant-storage/replicant-storage.ts";
import { TopicBrokerService } from "./services/topic-broker/topic-broker.ts";

export const fieldInternal = Symbol("fieldInternal");

export class ReplicantUpdateFnError extends Data.TaggedError(
	"ReplicantUpdateFnError",
)<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Update function for replicant "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
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

export class FieldPermissionDenied extends Data.TaggedError(
	"FieldPermissionDenied",
)<{
	namespace: string;
	name: string;
	operation: "read" | "write";
}> {
	override readonly message = `Permission denied to ${this.operation} "${this.name}" in "${this.namespace}"`;
}

export class RpcCallFailed extends Data.TaggedError("RpcCallFailed")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `RPC handler for "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

// TODO: support automatic migrations
const migrationDie = () =>
	new Error(
		"Currently stored replicant value failed schema validation. Migration is not supported yet.",
	);

const implementReplicant = Effect.fn("implementReplicant")(function* <Decoded>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
) {
	const storage = yield* ReplicantStorageService;

	const get = Effect.fn("get")(function* () {
		const current = yield* Option.match(storage.read(namespace, name), {
			onNone: () => new ReplicantNotFound({ namespace, name }),
			onSome: Effect.succeed,
		});
		return yield* manifest.decode(current).pipe(Effect.orDieWith(migrationDie));
	});

	const getEncodedNoAuth = Effect.fn("getEncodedNoAuth")(function* () {
		const encoded = yield* Option.match(storage.read(namespace, name), {
			onNone: () => new ReplicantNotFound({ namespace, name }),
			onSome: Effect.succeed,
		});
		yield* manifest.decode(encoded).pipe(Effect.orDieWith(migrationDie));
		return encoded;
	});

	const getEncoded = Effect.fn("getEncoded")(function* () {
		const identity = yield* CurrentIdentity;
		if (!manifest.permission.canRead(identity)) {
			return yield* new FieldPermissionDenied({
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
			return yield* new FieldPermissionDenied({
				namespace,
				name,
				operation: "write",
			});
		}
		yield* manifest.decode(value); // Only for validation
		return yield* storage.update(namespace, name, value);
	});

	const update = Effect.fn("update")(function* (
		fn: (value: Decoded) => Decoded,
	) {
		const current = yield* get();
		const next = yield* Effect.try({
			try: () => fn(current),
			catch: (error) =>
				new ReplicantUpdateFnError({ namespace, name, cause: toError(error) }),
		});
		const encoded = yield* manifest.encode(next);
		yield* storage.update(namespace, name, encoded);
	});

	const subscribeEncoded = Effect.fn("subscribeEncoded")(function* () {
		const changesStream = yield* storage.subscribe();
		const replicantValueStream = changesStream.pipe(
			Stream.filter(
				(change) => change.namespace === namespace && change.name === name,
			),
			Stream.map((change) => change.value),
		);
		const initialValue = yield* getEncodedNoAuth();
		return Stream.concat(Stream.succeed(initialValue), replicantValueStream);
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
			getEncoded,
			setEncoded,
			subscribeEncoded,
			permission: manifest.permission,
		},
	};
});

type ReplicantFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof implementReplicant<Decoded>>
>;

const implementComputed = Effect.fn("implementComputed")(function* <
	Sources,
	Decoded,
>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
	compute: (sources: Sources) => Decoded,
	readSnapshot: Effect.Effect<Sources, ReplicantNotFound>,
) {
	const storage = yield* ReplicantStorageService;

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
			return yield* new FieldPermissionDenied({
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
					`Failed to compute replicant "${namespace}/${name}"`,
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
			return yield* new FieldPermissionDenied({
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

const implementRpc = <Request, Response, Ctx = unknown>(
	namespace: string,
	name: string,
	manifest: RpcFieldManifest<Request, Response>,
	handler: (request: Request, ctx: Ctx) => Promisable<Response>,
	ctx: Ctx,
) => {
	const callEncoded = Effect.fn("callEncoded")(function* (payload: JsonValue) {
		const identity = yield* CurrentIdentity;
		if (!manifest.permission.canWrite(identity)) {
			return yield* new FieldPermissionDenied({
				namespace,
				name,
				operation: "write",
			});
		}
		const request = yield* manifest.request.decode(payload);
		const response = yield* Effect.tryPromise({
			try: async () => handler(request, ctx),
			catch: (error) =>
				new RpcCallFailed({ namespace, name, cause: toError(error) }),
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

interface FieldManifestLambda extends HKT.TypeLambda {
	readonly type: FieldManifest<this["Target"]>;
}

interface DecodedLambda extends HKT.TypeLambda {
	readonly type: this["Target"];
}

interface ComputeFnLambda extends HKT.TypeLambda {
	readonly type: (sources: this["In"]) => this["Target"];
}

interface ReplicantFieldEffectLambda extends HKT.TypeLambda {
	readonly type: ReplicantFieldEffect<this["Target"]>;
}

interface ComputedFieldEffectLambda extends HKT.TypeLambda {
	readonly type: ComputedFieldEffect<this["Target"]>;
}

interface TopicFieldEffectLambda extends HKT.TypeLambda {
	readonly type: TopicFieldEffect<this["Target"]>;
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
		ctx: this["In"],
	) => Promisable<this["Target"]["response"]>;
}

interface RpcReplicantAccessorLambda extends HKT.TypeLambda {
	readonly type: RpcReplicantAccessor<this["Target"]>;
}

interface RpcComputedAccessorLambda extends HKT.TypeLambda {
	readonly type: RpcComputedAccessor<this["Target"]>;
}

interface RpcTopicAccessorLambda extends HKT.TypeLambda {
	readonly type: RpcTopicAccessor<this["Target"]>;
}

interface RpcFieldEffectLambda extends HKT.TypeLambda {
	readonly Target: { readonly request: unknown; readonly response: unknown };
	readonly type: RpcFieldEffect<
		this["Target"]["request"],
		this["Target"]["response"]
	>;
}

export interface BuiltNamespace<
	Replicant extends Record<string, unknown> = Record<string, unknown>,
	Computed extends Record<string, unknown> = Record<string, unknown>,
	Topic extends Record<string, unknown> = Record<string, unknown>,
	Rpc extends RpcShape = RpcShape,
> {
	readonly replicant: {
		readonly [K in keyof Replicant & string]: ReplicantFieldEffect<
			Replicant[K]
		>;
	};
	readonly computed: {
		readonly [K in keyof Computed & string]: ComputedFieldEffect<Computed[K]>;
	};
	readonly topic: {
		readonly [K in keyof Topic & string]: TopicFieldEffect<Topic[K]>;
	};
	readonly rpc: {
		readonly [K in keyof Rpc & string]: RpcFieldEffect<
			Rpc[K]["request"],
			Rpc[K]["response"]
		>;
	};
}

export const buildNamespace = <
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
>(
	manifest: NamespaceManifest<Replicant, Computed, Topic, Rpc>,
	options?: NamespaceOptions<Replicant, Computed, Topic, Rpc>,
) => {
	const seedReplicant = options?.seedReplicant;
	const computeFns = options?.implementComputed;
	const rpcHandlers = options?.implementRpc;
	return Effect.gen(function* () {
		const storage = yield* ReplicantStorageService;

		yield* Effect.all(
			Object.entries(manifest.replicant).map(
				([name, codec]: [string, FieldManifest<unknown>]) => {
					const seed = Effect.gen(function* () {
						const thunk = seedReplicant?.[name];
						if (typeof thunk === "undefined") {
							return yield* Effect.die(
								new Error(`Missing seed value for replicant "${name}"`),
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

		const replicant = yield* mapEffectValues<
			FieldManifestLambda,
			ReplicantFieldEffectLambda
		>()((codec, name) => implementReplicant(manifest.namespace, name, codec))(
			manifest.replicant,
		);

		const readSnapshot: Effect.Effect<
			SourceSnapshot<Replicant>,
			ReplicantNotFound
		> = mapEffectValues<FieldManifestLambda, DecodedLambda>()((codec, name) =>
			Effect.gen(function* () {
				const encoded = yield* Option.match(
					storage.read(manifest.namespace, name),
					{
						onNone: () =>
							new ReplicantNotFound({ namespace: manifest.namespace, name }),
						onSome: Effect.succeed,
					},
				);
				return yield* codec
					.decode(encoded)
					.pipe(Effect.orDieWith(migrationDie));
			}),
		)(manifest.replicant);

		const computed = yield* zipEffectValues<
			FieldManifestLambda,
			ComputeFnLambda,
			ComputedFieldEffectLambda,
			SourceSnapshot<Replicant>,
			Computed
		>()(manifest.computed, computeFns, (codec, compute, name) =>
			implementComputed(manifest.namespace, name, codec, compute, readSnapshot),
		);

		// Eager compute at load and fail-fast validation
		yield* Effect.forEach(
			Object.values(computed),
			(field) => field[fieldInternal].getEncodedNoAuth(),
			{ concurrency: "unbounded", discard: true },
		);

		const topic = yield* mapEffectValues<
			FieldManifestLambda,
			TopicFieldEffectLambda
		>()((codec, name) => implementTopic(manifest.namespace, name, codec))(
			manifest.topic,
		);

		const runtime = yield* Effect.runtime();
		const rpcContext: RpcContext<Replicant, Computed, Topic> = {
			replicant: mapValues<
				ReplicantFieldEffectLambda,
				RpcReplicantAccessorLambda
			>((field) => ({
				get: () => Runtime.runSync(runtime, field.get()),
				set: (value) => Runtime.runSync(runtime, field.set(value)),
				update: (fn) => Runtime.runSync(runtime, field.update(fn)),
			}))(replicant),
			computed: mapValues<ComputedFieldEffectLambda, RpcComputedAccessorLambda>(
				(field) => ({ get: () => Runtime.runSync(runtime, field.get()) }),
			)(computed),
			topic: mapValues<TopicFieldEffectLambda, RpcTopicAccessorLambda>(
				(field) => ({
					publish: (value) => Runtime.runPromise(runtime, field.publish(value)),
				}),
			)(topic),
		};

		const rpc = yield* zipEffectValues<
			RpcFieldManifestLambda,
			RpcHandlerLambda,
			RpcFieldEffectLambda,
			RpcContext<Replicant, Computed, Topic>,
			Rpc
		>()(manifest.rpc, rpcHandlers, (codec, handler, name) =>
			implementRpc(manifest.namespace, name, codec, handler, rpcContext),
		);

		return { replicant, computed, topic, rpc };
	});
};
