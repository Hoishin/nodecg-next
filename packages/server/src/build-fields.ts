import type {
	WidestNamespaceFields,
	NamespaceManifest,
} from "@nodecg-next/core";
import { CurrentIdentity, ServerIdentity } from "@nodecg-next/internal";
import {
	mapValues,
	mapEffectValues,
	toError,
	zipEffectValues,
} from "@nodecg-next/internal/utils";
import { Context, Effect, Layer, Option, Result, Schema } from "effect";

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
	ReplicantFieldManifestLambda,
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
	ComputeContext,
	ImplementedNamespace,
	NamespaceOptions,
	RpcContext,
	WidenedImplementedNamespace,
} from "./implement-namespace.ts";
import {
	ComputedComputeError,
	ReplicantStoreService,
} from "./replicant-store.ts";
import type { TopicBrokerService } from "./services/topic-broker/topic-broker.ts";

const serverIdentity = ServerIdentity.make({});

const asServer = Effect.provideService(CurrentIdentity, serverIdentity);

export class NamespaceNotLoaded extends Schema.TaggedError<NamespaceNotLoaded>()(
	"NamespaceNotLoaded",
	{ namespace: Schema.String },
) {
	override readonly message = `Namespace "${this.namespace}" was not loaded — pass it to loadNodeCG's namespaces`;
}

export class LoadedNamespacesService extends Context.Service<
	LoadedNamespacesService,
	ReadonlySet<string>
>()("LoadedNamespaces") {}

// ctx.use lookup keyed by ImplementedNamespace. Returns typed whole namespace
export class BuiltNamespaceRegistry extends Context.Service<BuiltNamespaceRegistry>()(
	"BuiltNamespaceRegistry",
	{
		make: Effect.sync(() => {
			const map = new WeakMap<WidenedImplementedNamespace, unknown>();
			return {
				register: <S extends WidestNamespaceFields>(
					implemented: ImplementedNamespace<S>,
					built: BuiltNamespace<S>,
				) =>
					Effect.sync(() => {
						map.set(implemented, built);
					}),
				lookup: <S extends WidestNamespaceFields>(
					implemented: ImplementedNamespace<S>,
				) => {
					const found = map.get(implemented);
					if (typeof found === "undefined") {
						return Result.fail(
							NamespaceNotLoaded.make({
								namespace: implemented.manifest.namespace,
							}),
						);
					}
					// Relevant map value is set right above
					return Result.succeed(found as BuiltNamespace<S>);
				},
			};
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make);
}

type FieldOps =
	| TopicBrokerService
	| ReplicantStoreService
	| BuiltNamespaceRegistry;

type FieldOpsContext = Context.Context<FieldOps>;

const lookupLoaded = <S extends WidestNamespaceFields>(
	registry: BuiltNamespaceRegistry["Service"],
	loaded: Option.Option<ReadonlySet<string>>,
	implemented: ImplementedNamespace<S>,
) => {
	const namespace = implemented.manifest.namespace;
	if (Option.isSome(loaded) && !loaded.value.has(namespace)) {
		return Result.fail(NamespaceNotLoaded.make({ namespace }));
	}
	return registry.lookup(implemented);
};

const makeCrossComputeView = <S extends WidestNamespaceFields>(
	fields: BuiltNamespace<S>,
) => ({
	replicant: mapValues<ReplicantFieldEffectLambda, CrossFieldReadLambda>(
		(field) => ({
			get: () =>
				Result.getOrThrow(field[fieldInternal].getResult(serverIdentity)),
		}),
	)(fields.replicant),
	computed: mapValues<ComputedFieldEffectLambda, CrossFieldReadLambda>(
		(field) => ({
			get: () =>
				Result.getOrThrow(field[fieldInternal].getResult(serverIdentity)),
		}),
	)(fields.computed),
});

// TODO: use Effect's R instead of Context
const fieldAccessors =
	(context: FieldOpsContext) =>
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
	}) => {
		const runPromise = Effect.runPromiseWith(context);
		return {
			replicant: mapValues<
				ReplicantFieldEffectLambda,
				RpcReplicantAccessorLambda
			>((field) => ({
				get: () =>
					Result.getOrThrow(field[fieldInternal].getResult(serverIdentity)),
				set: (value) => runPromise(field.set(value).pipe(asServer)),
				update: (fn) => runPromise(field.update(fn).pipe(asServer)),
			}))(fields.replicant),
			computed: mapValues<ComputedFieldEffectLambda, RpcComputedAccessorLambda>(
				(field) => ({
					get: () =>
						Result.getOrThrow(field[fieldInternal].getResult(serverIdentity)),
				}),
			)(fields.computed),
			topic: mapValues<TopicFieldEffectLambda, RpcTopicAccessorLambda>(
				(field) => ({
					publish: (value) => runPromise(field.publish(value).pipe(asServer)),
				}),
			)(fields.topic),
		};
	};

export const makeCrossNamespaceHandle = <S extends WidestNamespaceFields>(
	context: FieldOpsContext,
	registry: BuiltNamespaceRegistry["Service"],
	loaded: Option.Option<ReadonlySet<string>>,
	implemented: ImplementedNamespace<S>,
) => {
	const fields = Result.getOrThrow(lookupLoaded(registry, loaded, implemented));
	return {
		...fieldAccessors(context)(fields),
		rpc: mapValues<RpcFieldEffectLambda, RpcFieldLambda>(
			(field) => (request) =>
				Effect.runPromiseWith(context)(field.call(request).pipe(asServer)),
		)(fields.rpc),
	};
};

export const buildFields = Effect.fn("buildFields")(function* <
	S extends WidestNamespaceFields,
>(
	manifest: NamespaceManifest<string, S, string>,
	options?: NamespaceOptions<S>,
) {
	const seedReplicantFns = options?.seedReplicant;
	const computeFns = options?.implementComputed;
	const rpcHandlers = options?.implementRpc;

	const context = yield* Effect.context<FieldOps>();
	const loaded = yield* Effect.serviceOption(LoadedNamespacesService);

	const replicant = yield* zipEffectValues<
		ReplicantFieldManifestLambda,
		SeedFnLambda,
		ReplicantFieldEffectLambda,
		unknown,
		S["replicant"]
	>()(manifest.replicant, seedReplicantFns, (codec, seed, name) =>
		buildReplicant(manifest.namespace, name, codec, seed()),
	);

	type OwnComputeContext = ComputeContext<S["replicant"], S["computed"]>;

	let ownComputedAccessors: OwnComputeContext["computed"] | undefined;
	const computeContext: OwnComputeContext = {
		replicant: mapValues<ReplicantFieldEffectLambda, CrossFieldReadLambda>(
			(field) => ({
				get: () =>
					Result.getOrThrow(field[fieldInternal].getResult(serverIdentity)),
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
		use: (implemented) =>
			makeCrossComputeView(
				Result.getOrThrow(
					lookupLoaded(
						Context.get(context, BuiltNamespaceRegistry),
						loaded,
						implemented,
					),
				),
			),
	};

	const computed = yield* zipEffectValues<
		FieldManifestLambda,
		ComputeFnLambda,
		ComputedFieldEffectLambda,
		OwnComputeContext,
		S["computed"]
	>()(manifest.computed, computeFns, (codec, compute, name) =>
		buildComputed(manifest.namespace, name, codec, () =>
			Result.try({
				try: () => compute(computeContext),
				catch: (error) =>
					ComputedComputeError.make({
						namespace: manifest.namespace,
						name,
						cause: toError(error),
					}),
			}),
		),
	);

	ownComputedAccessors = mapValues<
		ComputedFieldEffectLambda,
		CrossFieldReadLambda
	>((field) => ({
		get: () =>
			Result.getOrThrow(field[fieldInternal].getResult(serverIdentity)),
	}))(computed);

	const topic = yield* mapEffectValues<
		FieldManifestLambda,
		TopicFieldEffectLambda
	>()((codec, name) => buildTopic(manifest.namespace, name, codec))(
		manifest.topic,
	);

	const rpcContext: RpcContext<S> = {
		...fieldAccessors(context)({ replicant, computed, topic }),
		use: (implemented) =>
			makeCrossNamespaceHandle(
				context,
				Context.get(context, BuiltNamespaceRegistry),
				loaded,
				implemented,
			),
	};

	const rpc = yield* zipEffectValues<
		RpcFieldManifestLambda,
		RpcHandlerLambda,
		RpcFieldEffectLambda,
		RpcContext<S>,
		S["rpc"]
	>()(manifest.rpc, rpcHandlers, (codec, handler, name) =>
		buildRpc(manifest.namespace, name, codec, handler, rpcContext),
	);

	return { namespace: manifest.namespace, replicant, computed, topic, rpc };
});

export interface BuiltNamespace<
	S extends WidestNamespaceFields = WidestNamespaceFields,
> extends Effect.Success<ReturnType<typeof buildFields<S>>> {}
