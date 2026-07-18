import type { NamespaceManifest } from "@nodecg/core";
import { mapValues } from "@nodecg/internal/utils";
import { Data, Effect, Exit, Runtime, Scope, Stream } from "effect";
import type { Promisable } from "type-fest";

import {
	asServer,
	type BuiltNamespace,
	buildFields,
	BuiltNamespaceRegistry,
} from "./build-fields.ts";
import { DerivationEngineService } from "./derivation-graph.ts";
import type {
	ComputedFieldEffectLambda,
	ComputedFieldLambda,
	ReplicantFieldEffectLambda,
	ReplicantFieldLambda,
	RpcFieldEffectLambda,
	RpcFieldLambda,
	TopicFieldEffectLambda,
	TopicFieldLambda,
} from "./field-lambdas.ts";
import type {
	LoadedNamespace,
	NamespaceOptions,
	RpcShape,
} from "./implement-namespace.ts";
import { ReplicantStorageService } from "./services/replicant-storage/replicant-storage.ts";
import type { TopicBrokerService } from "./services/topic-broker/topic-broker.ts";

export class MissingReplicantSeedError extends Data.TaggedError(
	"MissingReplicantSeedError",
)<{
	namespace: string;
	name: string;
}> {
	override readonly message = `Missing seed value for replicant "${this.name}" in "${this.namespace}"`;
}

export const buildNamespace = Effect.fn("buildNamespace")(function* <
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
>(
	manifest: NamespaceManifest<Replicant, Computed, Topic, Rpc>,
	options?: NamespaceOptions<Replicant, Computed, Topic, Rpc>,
) {
	const seedReplicant = options?.seedReplicant;
	const storage = yield* ReplicantStorageService;
	const engine = yield* DerivationEngineService;

	for (const name of Object.keys(manifest.replicant)) {
		if (typeof seedReplicant?.[name] === "undefined") {
			return yield* new MissingReplicantSeedError({
				namespace: manifest.namespace,
				name,
			});
		}
	}

	const built = yield* buildFields(manifest, options);
	const registry = yield* BuiltNamespaceRegistry;
	yield* registry.register(built);

	yield* Effect.all(
		Object.keys(manifest.replicant).map((name) =>
			storage.read(manifest.namespace, name).pipe(
				Effect.flatMap((persisted) =>
					engine.setReplicant(manifest.namespace, name, persisted),
				),
				Effect.catchTag("ReplicantNotFound", () =>
					engine
						.readReplicant(manifest.namespace, name)
						.pipe(
							Effect.flatMap((seeded) =>
								storage.create(manifest.namespace, name, seeded),
							),
						),
				),
			),
		),
		{ concurrency: "unbounded" },
	);

	return built;
});

export const adaptNamespace = Effect.fn("adaptNamespace")(function* <
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends RpcShape,
>(built: BuiltNamespace<Replicant, Computed, Topic, Rpc>) {
	const runtime = yield* Effect.runtime<
		ReplicantStorageService | TopicBrokerService | DerivationEngineService
	>();

	const subscribeAdapter =
		<Decoded, E>(
			subscribe: () => Effect.Effect<
				Stream.Stream<
					Decoded,
					never,
					ReplicantStorageService | TopicBrokerService | DerivationEngineService
				>,
				E,
				| ReplicantStorageService
				| TopicBrokerService
				| DerivationEngineService
				| Scope.Scope
			>,
			name: string,
		) =>
		async (handler: (value: Decoded) => Promisable<void>) =>
			Runtime.runPromise(
				runtime,
				Effect.gen(function* () {
					const scope = yield* Scope.make();
					const subscription = yield* subscribe().pipe(Scope.extend(scope));
					yield* Effect.forkIn(
						Stream.runForEach(subscription, (value) =>
							Effect.tryPromise(async () => handler(value)).pipe(
								Effect.catchAll((error) =>
									Effect.logError(
										`Subscription handler for "${built.namespace}/${name}" threw`,
										error,
									),
								),
							),
						).pipe(Effect.ensureErrorType<never>()),
						scope,
					);
					return async () => {
						await Runtime.runPromise(runtime, Scope.close(scope, Exit.void));
					};
				}),
			);

	const loaded: LoadedNamespace<Replicant, Computed, Topic, Rpc> = {
		replicant: mapValues<ReplicantFieldEffectLambda, ReplicantFieldLambda>(
			(field, name) => ({
				get: () => Runtime.runSync(runtime, field.get().pipe(asServer)),
				set: (value) =>
					Runtime.runSync(runtime, field.set(value).pipe(asServer)),
				update: (fn) =>
					Runtime.runSync(runtime, field.update(fn).pipe(asServer)),
				validate: (value) => Runtime.runPromise(runtime, field.validate(value)),
				subscribe: subscribeAdapter(field.subscribe, name),
			}),
		)(built.replicant),
		computed: mapValues<ComputedFieldEffectLambda, ComputedFieldLambda>(
			(field, name) => ({
				get: () => Runtime.runSync(runtime, field.get().pipe(asServer)),
				subscribe: subscribeAdapter(field.subscribe, name),
			}),
		)(built.computed),
		topic: mapValues<TopicFieldEffectLambda, TopicFieldLambda>(
			(field, name) => ({
				publish: (value) =>
					Runtime.runPromise(runtime, field.publish(value).pipe(asServer)),
				subscribe: subscribeAdapter(field.subscribe, name),
			}),
		)(built.topic),
		rpc: mapValues<RpcFieldEffectLambda, RpcFieldLambda>(
			(field) => (request) =>
				Runtime.runPromise(runtime, field.call(request).pipe(asServer)),
		)(built.rpc),
	};
	return loaded;
});
