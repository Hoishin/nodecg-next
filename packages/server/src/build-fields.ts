import type { NamespaceManifest } from "@nodecg/core";
import { CurrentIdentity, ServerIdentitySchema } from "@nodecg/internal";
import {
	mapValues,
	mapEffectValues,
	zipEffectValues,
} from "@nodecg/internal/utils";
import { Context, Data, Effect, Option, Runtime } from "effect";

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
import { migrationDie } from "./field-builders/migration-die.ts";
import { requirePermission } from "./field-builders/permission.ts";
import type {
	ComputedFieldEffectLambda,
	ComputeFnLambda,
	CrossReplicantReadLambda,
	DecodedLambda,
	FieldManifestLambda,
	ReplicantFieldEffectLambda,
	RpcComputedAccessorLambda,
	RpcFieldEffectLambda,
	RpcFieldLambda,
	RpcFieldManifestLambda,
	RpcHandlerLambda,
	RpcReplicantAccessorLambda,
	RpcTopicAccessorLambda,
	TopicFieldEffectLambda,
} from "./field-lambdas.ts";
import type {
	ComputeContext,
	NamespaceOptions,
	RpcContext,
	RpcShape,
	SourceSnapshot,
	UseCrossNamespace,
} from "./implement-namespace.ts";
import {
	ReplicantNotFound,
	ReplicantStorageService,
} from "./services/replicant-storage/replicant-storage.ts";
import type { TopicBrokerService } from "./services/topic-broker/topic-broker.ts";

export const asServer = Effect.provideService(
	CurrentIdentity,
	ServerIdentitySchema.make(),
);

export class NamespaceNotLoaded extends Data.TaggedError("NamespaceNotLoaded")<{
	namespace: string;
}> {
	override readonly message = `Namespace "${this.namespace}" was not loaded — pass it to loadNodeCG's namespaces`;
}

export class LoadedNamespacesService extends Context.Tag("LoadedNamespaces")<
	LoadedNamespacesService,
	ReadonlySet<string>
>() {}

export const requireLoaded = (namespace: string) =>
	Effect.gen(function* () {
		const loaded = yield* Effect.serviceOption(LoadedNamespacesService);
		if (Option.isSome(loaded) && !loaded.value.has(namespace)) {
			return yield* new NamespaceNotLoaded({ namespace });
		}
	});

type FieldOpsRuntime = Runtime.Runtime<
	ReplicantStorageService | TopicBrokerService
>;

const makeComputeUse =
	(runtime: FieldOpsRuntime): ComputeContext["use"] =>
	(implemented) => {
		const targetNamespace = implemented.manifest.namespace;
		Runtime.runSync(runtime, requireLoaded(targetNamespace));
		return {
			replicant: mapValues<FieldManifestLambda, CrossReplicantReadLambda>(
				(codec, name) => ({
					get: () =>
						Runtime.runSync(
							runtime,
							Effect.gen(function* () {
								yield* requirePermission(
									codec.permission,
									targetNamespace,
									name,
									"read",
								);
								const storage = yield* ReplicantStorageService;
								const encoded = yield* storage.read(targetNamespace, name);
								return yield* codec.decode(encoded).pipe(migrationDie);
							}).pipe(asServer),
						),
				}),
			)(implemented.manifest.replicant),
		};
	};

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

export const makeUseCross = (runtime: FieldOpsRuntime): UseCrossNamespace => {
	return (implemented) => {
		const fields = Runtime.runSync(
			runtime,
			requireLoaded(implemented.manifest.namespace).pipe(
				Effect.andThen(buildFields(implemented.manifest, implemented.impl)),
			),
		);
		return {
			...fieldAccessors(runtime)(fields),
			rpc: mapValues<RpcFieldEffectLambda, RpcFieldLambda>(
				(field) => (request) =>
					Runtime.runPromise(runtime, field.call(request).pipe(asServer)),
			)(fields.rpc),
		};
	};
};

export const buildFields = Effect.fn("buildFields")(function* <
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
>(
	manifest: NamespaceManifest<Replicant, Computed, Topic, Rpc>,
	options?: NamespaceOptions<Replicant, Computed, Topic, Rpc>,
) {
	const computeFns = options?.implementComputed;
	const rpcHandlers = options?.implementRpc;

	const runtime = yield* Effect.runtime<
		ReplicantStorageService | TopicBrokerService
	>();

	const replicant = yield* mapEffectValues<
		FieldManifestLambda,
		ReplicantFieldEffectLambda
	>()((codec, name) => buildReplicant(manifest.namespace, name, codec))(
		manifest.replicant,
	);

	const readSnapshot: Effect.Effect<
		SourceSnapshot<Replicant>,
		ReplicantNotFound,
		ReplicantStorageService
	> = mapEffectValues<FieldManifestLambda, DecodedLambda>()((codec, name) =>
		Effect.gen(function* () {
			const storage = yield* ReplicantStorageService;
			const encoded = yield* storage.read(manifest.namespace, name);
			return yield* codec.decode(encoded).pipe(migrationDie);
		}),
	)(manifest.replicant);

	const computeContext: ComputeContext = { use: makeComputeUse(runtime) };

	const computed = yield* zipEffectValues<
		FieldManifestLambda,
		ComputeFnLambda,
		ComputedFieldEffectLambda,
		SourceSnapshot<Replicant>,
		Computed
	>()(manifest.computed, computeFns, (codec, compute, name) =>
		buildComputed(
			manifest.namespace,
			name,
			codec,
			compute,
			readSnapshot,
			computeContext,
		),
	);

	const topic = yield* mapEffectValues<
		FieldManifestLambda,
		TopicFieldEffectLambda
	>()((codec, name) => buildTopic(manifest.namespace, name, codec))(
		manifest.topic,
	);

	const rpcContext: RpcContext<Replicant, Computed, Topic> = {
		...fieldAccessors(runtime)({ replicant, computed, topic }),
		use: makeUseCross(runtime),
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
