import type { NamespaceManifest } from "@nodecg/core";
import { CurrentIdentity, ServerIdentitySchema } from "@nodecg/internal";
import {
	mapValues,
	mapEffectValues,
	toError,
	zipEffectValues,
} from "@nodecg/internal/utils";
import { Context, Effect, Option, Runtime, Schema } from "effect";

import {
	ComputedComputeError,
	DerivationEngineService,
} from "./derivation-graph.ts";
import {
	buildComputed,
	type ComputedFieldEffect,
} from "./field-builders/build-computed.ts";
import {
	buildReplicant,
	type ReplicantFieldEffect,
} from "./field-builders/build-replicant.ts";
import { buildRpc } from "./field-builders/build-rpc.ts";
import {
	buildTopic,
	type TopicFieldEffect,
} from "./field-builders/build-topic.ts";
import { fieldInternal } from "./field-builders/field-internal-key.ts";
import type {
	ComputedFieldEffectLambda,
	ComputeFnLambda,
	CrossFieldReadLambda,
	FieldManifestLambda,
	ReplicantFieldEffectLambda,
	RpcComputedAccessorLambda,
	RpcFieldEffectLambda,
	RpcFieldLambda,
	RpcFieldManifestLambda,
	RpcHandlerLambda,
	RpcReplicantAccessorLambda,
	RpcTopicAccessorLambda,
	SeedFnLambda,
	TopicFieldEffectLambda,
} from "./field-lambdas.ts";
import type {
	BaseNamespaceShape,
	ComputeContext,
	ImplementedNamespace,
	NamespaceOptions,
	RpcContext,
	RpcShape,
	WidenedImplementedNamespace,
} from "./implement-namespace.ts";
import { ReplicantStorageService } from "./services/replicant-storage/replicant-storage.ts";
import type { TopicBrokerService } from "./services/topic-broker/topic-broker.ts";

export const asServer = Effect.provideService(
	CurrentIdentity,
	ServerIdentitySchema.make(),
);

export class NamespaceNotLoaded extends Schema.TaggedError<NamespaceNotLoaded>()(
	"NamespaceNotLoaded",
	{ namespace: Schema.String },
) {
	override readonly message = `Namespace "${this.namespace}" was not loaded — pass it to loadNodeCG's namespaces`;
}

export class LoadedNamespacesService extends Context.Tag("LoadedNamespaces")<
	LoadedNamespacesService,
	ReadonlySet<string>
>() {}

// ctx.use lookup keyed by ImplementedNamespace. Returns typed whole namespace
export class BuiltNamespaceRegistry extends Effect.Service<BuiltNamespaceRegistry>()(
	"BuiltNamespaceRegistry",
	{
		sync: () => {
			const map = new WeakMap<WidenedImplementedNamespace, unknown>();
			return {
				register: <S extends BaseNamespaceShape>(
					implemented: ImplementedNamespace<S>,
					built: BuiltNamespace<
						S["replicant"],
						S["computed"],
						S["topic"],
						S["rpc"]
					>,
				) =>
					Effect.sync(() => {
						map.set(implemented, built);
					}),
				lookup: <S extends BaseNamespaceShape>(
					implemented: ImplementedNamespace<S>,
				) =>
					Effect.gen(function* () {
						const found = map.get(implemented);
						if (typeof found === "undefined") {
							return yield* new NamespaceNotLoaded({
								namespace: implemented.manifest.namespace,
							});
						}
						return found as BuiltNamespace<
							S["replicant"],
							S["computed"],
							S["topic"],
							S["rpc"]
						>;
					}),
			};
		},
	},
) {}

export const requireLoaded = (namespace: string) =>
	Effect.gen(function* () {
		const loaded = yield* Effect.serviceOption(LoadedNamespacesService);
		if (Option.isSome(loaded) && !loaded.value.has(namespace)) {
			return yield* new NamespaceNotLoaded({ namespace });
		}
	});

type FieldOps =
	| ReplicantStorageService
	| TopicBrokerService
	| DerivationEngineService
	| BuiltNamespaceRegistry;

type FieldOpsRuntime = Runtime.Runtime<FieldOps>;

const lookupLoaded = <S extends BaseNamespaceShape>(
	implemented: ImplementedNamespace<S>,
) =>
	Effect.gen(function* () {
		yield* requireLoaded(implemented.manifest.namespace);
		const registry = yield* BuiltNamespaceRegistry;
		return yield* registry.lookup(implemented);
	});

const makeComputeUse = <S extends BaseNamespaceShape>(
	implemented: ImplementedNamespace<S>,
) =>
	Effect.gen(function* () {
		const fields = yield* lookupLoaded(implemented);
		const runtime = yield* Effect.runtime<FieldOps>();
		return {
			replicant: mapValues<ReplicantFieldEffectLambda, CrossFieldReadLambda>(
				(field) => ({
					get: () =>
						Runtime.runSync(runtime, field[fieldInternal].get().pipe(asServer)),
				}),
			)(fields.replicant),
			computed: mapValues<ComputedFieldEffectLambda, CrossFieldReadLambda>(
				(field) => ({
					get: () =>
						Runtime.runSync(runtime, field[fieldInternal].get().pipe(asServer)),
				}),
			)(fields.computed),
		};
	});

const fieldAccessors =
	(runtime: FieldOpsRuntime) =>
	<
		Replicant extends Record<string, unknown>,
		Computed extends Record<string, unknown>,
		Topic extends Record<string, unknown>,
	>(fields: {
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
	}) => ({
		replicant: mapValues<
			ReplicantFieldEffectLambda,
			RpcReplicantAccessorLambda
		>((field) => ({
			get: () => Runtime.runSync(runtime, field.get().pipe(asServer)),
			set: (value) => Runtime.runSync(runtime, field.set(value).pipe(asServer)),
			update: (fn) => Runtime.runSync(runtime, field.update(fn).pipe(asServer)),
		}))(fields.replicant),
		computed: mapValues<ComputedFieldEffectLambda, RpcComputedAccessorLambda>(
			(field) => ({
				get: () => Runtime.runSync(runtime, field.get().pipe(asServer)),
			}),
		)(fields.computed),
		topic: mapValues<TopicFieldEffectLambda, RpcTopicAccessorLambda>(
			(field) => ({
				publish: (value) =>
					Runtime.runPromise(runtime, field.publish(value).pipe(asServer)),
			}),
		)(fields.topic),
	});

export const makeUseCross = <S extends BaseNamespaceShape>(
	implemented: ImplementedNamespace<S>,
) =>
	Effect.gen(function* () {
		const fields = yield* lookupLoaded(implemented);
		const runtime = yield* Effect.runtime<FieldOps>();
		return {
			...fieldAccessors(runtime)(fields),
			rpc: mapValues<RpcFieldEffectLambda, RpcFieldLambda>(
				(field) => (request) =>
					Runtime.runPromise(runtime, field.call(request).pipe(asServer)),
			)(fields.rpc),
		};
	});

export const buildFields = Effect.fn("buildFields")(function* <
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
>(
	manifest: NamespaceManifest<Replicant, Computed, Topic, Rpc>,
	options?: NamespaceOptions<Replicant, Computed, Topic, Rpc>,
) {
	const seedReplicantFns = options?.seedReplicant;
	const computeFns = options?.implementComputed;
	const rpcHandlers = options?.implementRpc;

	const runtime = yield* Effect.runtime<
		| ReplicantStorageService
		| TopicBrokerService
		| DerivationEngineService
		| BuiltNamespaceRegistry
	>();

	const replicant = yield* zipEffectValues<
		FieldManifestLambda,
		SeedFnLambda,
		ReplicantFieldEffectLambda,
		unknown,
		Replicant
	>()(manifest.replicant, seedReplicantFns, (codec, seed, name) =>
		buildReplicant(manifest.namespace, name, codec, seed()),
	);

	let ownComputedAccessors:
		| ComputeContext<Replicant, Computed>["computed"]
		| undefined;
	const computeContext: ComputeContext<Replicant, Computed> = {
		replicant: mapValues<ReplicantFieldEffectLambda, CrossFieldReadLambda>(
			(field) => ({
				get: () =>
					Runtime.runSync(runtime, field[fieldInternal].get().pipe(asServer)),
			}),
		)(replicant),
		get computed() {
			if (typeof ownComputedAccessors === "undefined") {
				throw new Error(
					"computed accessors are not available while the namespace is being built",
				);
			}
			return ownComputedAccessors;
		},
		use: <S extends BaseNamespaceShape>(implemented: ImplementedNamespace<S>) =>
			Runtime.runSync(runtime, makeComputeUse(implemented)),
	};

	const computed = yield* zipEffectValues<
		FieldManifestLambda,
		ComputeFnLambda,
		ComputedFieldEffectLambda,
		ComputeContext<Replicant, Computed>,
		Computed
	>()(manifest.computed, computeFns, (codec, compute, name) =>
		buildComputed(
			manifest.namespace,
			name,
			codec,
			Effect.gen(function* () {
				return yield* Effect.try({
					try: () => compute(computeContext),
					catch: (error) =>
						new ComputedComputeError({
							namespace: manifest.namespace,
							name,
							cause: toError(error),
						}),
				});
			}),
		),
	);

	ownComputedAccessors = mapValues<
		ComputedFieldEffectLambda,
		CrossFieldReadLambda
	>((field) => ({
		get: () =>
			Runtime.runSync(runtime, field[fieldInternal].get().pipe(asServer)),
	}))(computed);

	const topic = yield* mapEffectValues<
		FieldManifestLambda,
		TopicFieldEffectLambda
	>()((codec, name) => buildTopic(manifest.namespace, name, codec))(
		manifest.topic,
	);

	const rpcContext: RpcContext<Replicant, Computed, Topic> = {
		...fieldAccessors(runtime)({ replicant, computed, topic }),
		use: <S extends BaseNamespaceShape>(implemented: ImplementedNamespace<S>) =>
			Runtime.runSync(runtime, makeUseCross(implemented)),
	};

	const rpc = yield* zipEffectValues<
		RpcFieldManifestLambda,
		RpcHandlerLambda,
		RpcFieldEffectLambda,
		RpcContext<Replicant, Computed, Topic>,
		Rpc
	>()(manifest.rpc, rpcHandlers, (codec, handler, name) =>
		buildRpc(manifest.namespace, name, codec, handler, rpcContext),
	);

	return { namespace: manifest.namespace, replicant, computed, topic, rpc };
});

export interface BuiltNamespace<
	Replicant extends Record<string, unknown> = Record<string, unknown>,
	Computed extends Record<string, unknown> = Record<string, unknown>,
	Topic extends Record<string, unknown> = Record<string, unknown>,
	Rpc extends RpcShape = RpcShape,
> extends Effect.Effect.Success<
	ReturnType<typeof buildFields<Replicant, Computed, Topic, Rpc>>
> {}
