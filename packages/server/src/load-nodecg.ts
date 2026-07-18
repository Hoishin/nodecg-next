import { HttpApiBuilder } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { mapEffectValues, mapValues, toError } from "@nodecg/internal/utils";
import {
	Data,
	Effect,
	Exit,
	HashMap,
	type HKT,
	Layer,
	Logger,
	ManagedRuntime,
	Runtime,
	type Scope,
} from "effect";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "./auth/auth-provider.ts";
import {
	MachineAuthenticationMiddlewareLive,
	HumanAuthenticationMiddlewareLive,
} from "./auth/middleware.ts";
import {
	type BuiltNamespace,
	BuiltNamespaceRegistry,
	LoadedNamespacesService,
	makeUseCross,
} from "./build-fields.ts";
import { adaptNamespace, buildNamespace } from "./build-namespace.ts";
import { DerivationEngineService } from "./derivation-graph.ts";
import { fieldInternal } from "./field-builders/field-internal-key.ts";
import {
	FieldRegistryService,
	type RegisteredNamespace,
} from "./field-registry.ts";
import {
	type ImplementedNamespace,
	type LoadedNamespace,
	type BaseNamespaceShape,
	type WidenedImplementedNamespace,
} from "./implement-namespace.ts";
import { frontendRoutes } from "./server/frontend-serving.ts";
import { RootApiLive } from "./server/http-api/build-root-api.ts";
import { makeNodeHttpServer } from "./server/node-http-server.ts";
import { websocketRoute } from "./server/websocket.ts";
import { InMemoryMachineClientStore } from "./services/machine-client-store/in-memory-machine-client-store.ts";
import { InMemoryReplicantStorage } from "./services/replicant-storage/in-memory-replicant-storage.ts";
import {
	type ReplicantStorage,
	ReplicantStorageService,
} from "./services/replicant-storage/replicant-storage.ts";
import { InMemorySessionStore } from "./services/session-store/in-memory-session-store.ts";
import { InMemoryStashStore } from "./services/stash-store/in-memory-stash-store.ts";
import { InMemoryTopicBroker } from "./services/topic-broker/in-memory-topic-broker.ts";
import { TopicBrokerService } from "./services/topic-broker/topic-broker.ts";
import { seededRoleStore } from "./superadmin-seed.ts";

export type StorageOption =
	| ReplicantStorage
	| Effect.Effect<ReplicantStorage, never, never>;

export type LoadNodeCGOptions<
	Shapes extends Record<string, BaseNamespaceShape>,
> = {
	// TODO: Accept array of namespaces and use namespace names for keys
	namespaces: {
		readonly [K in keyof Shapes & string]: ImplementedNamespace<Shapes[K]>;
	};
	storage?: StorageOption;
	authProviders?: ReadonlyArray<AuthProvider>;
	dev?: boolean;
	onReady?: (address?: string) => void;
};

export type LoadedNamespaces<
	Shapes extends Record<string, BaseNamespaceShape>,
> = {
	readonly [K in keyof Shapes & string]: LoadedNamespace<
		Shapes[K]["replicant"],
		Shapes[K]["computed"],
		Shapes[K]["topic"],
		Shapes[K]["rpc"]
	>;
};

export class OnLoadFailed extends Data.TaggedError("OnLoadFailed")<{
	namespace: string;
	cause: Error;
}> {
	override readonly message = `onLoad for namespace "${this.namespace}" failed: ${this.cause.message}`;
}

const replicantStorage = (storage: StorageOption | undefined) => {
	if (typeof storage === "undefined") {
		return InMemoryReplicantStorage;
	}
	return Effect.isEffect(storage)
		? Layer.effect(ReplicantStorageService, storage)
		: Layer.succeed(ReplicantStorageService, storage);
};

interface NamespaceShapeTarget {
	readonly replicant: {};
	readonly computed: {};
	readonly topic: {};
	readonly rpc: {};
}

interface ImplementedNamespaceLambda extends HKT.TypeLambda {
	readonly Target: NamespaceShapeTarget;
	readonly type: ImplementedNamespace<this["Target"]>;
}

interface PreparedNamespace<S extends BaseNamespaceShape> {
	readonly built: BuiltNamespace<
		S["replicant"],
		S["computed"],
		S["topic"],
		S["rpc"]
	>;
	readonly loaded: LoadedNamespace<
		S["replicant"],
		S["computed"],
		S["topic"],
		S["rpc"]
	>;
	readonly runOnLoad: Effect.Effect<void, OnLoadFailed, Scope.Scope>;
}

interface PreparedNamespaceLambda extends HKT.TypeLambda {
	readonly Target: NamespaceShapeTarget;
	readonly type: PreparedNamespace<this["Target"]>;
}

interface LoadedNamespaceLambda extends HKT.TypeLambda {
	readonly Target: NamespaceShapeTarget;
	readonly type: LoadedNamespace<
		this["Target"]["replicant"],
		this["Target"]["computed"],
		this["Target"]["topic"],
		this["Target"]["rpc"]
	>;
}

/**
 * On startup, validate all computed fields against schema
 */
const validateComputedFields = (fields: RegisteredNamespace["fields"]) =>
	Effect.forEach(
		Object.values(fields.computed),
		(field) => field[fieldInternal].getEncodedNoAuth(),
		{ concurrency: "unbounded", discard: true },
	);

export const loadNodeCGEffect = Effect.fn("loadNodeCGEffect")(function* <
	Shapes extends Record<string, BaseNamespaceShape>,
>(options: LoadNodeCGOptions<Shapes>) {
	const widenedNamespaces: Readonly<
		Record<string, WidenedImplementedNamespace>
	> = options.namespaces;

	// Check duplicate namespace names
	const loaded = new Set<string>();
	for (const { manifest } of Object.values(widenedNamespaces)) {
		if (loaded.has(manifest.namespace)) {
			return yield* Effect.die(
				new Error(`Namespace "${manifest.namespace}" was loaded twice`),
			);
		}
		loaded.add(manifest.namespace);
	}

	return yield* Effect.gen(function* () {
		const runtime = yield* Effect.runtime<
			| ReplicantStorageService
			| TopicBrokerService
			| DerivationEngineService
			| BuiltNamespaceRegistry
		>();
		const engine = yield* DerivationEngineService;
		const useCross = <S extends BaseNamespaceShape>(
			implemented: ImplementedNamespace<S>,
		) => Runtime.runSync(runtime, makeUseCross(implemented));

		const prepareNamespace = Effect.fn("prepareNamespace")(function* <
			Target,
			In,
		>(
			implemented: HKT.Kind<
				ImplementedNamespaceLambda,
				In,
				never,
				never,
				Target
			>,
		) {
			const built = yield* buildNamespace(implemented);
			const handle = yield* adaptNamespace(built);
			const onLoad = implemented.impl?.onLoad;
			const runOnLoad =
				typeof onLoad === "undefined"
					? Effect.void
					: Effect.gen(function* () {
							const cleanup = yield* Effect.tryPromise({
								try: async () => onLoad({ ...handle, use: useCross }),
								catch: (error) =>
									new OnLoadFailed({
										namespace: implemented.manifest.namespace,
										cause: toError(error),
									}),
							});
							if (typeof cleanup === "function") {
								yield* Effect.addFinalizer(() =>
									Effect.tryPromise(async () => {
										await cleanup();
									}).pipe(
										Effect.catchAll((error) =>
											Effect.logError(
												`onLoad cleanup for namespace "${implemented.manifest.namespace}" threw`,
												error,
											),
										),
									),
								);
							}
						});
			const prepared: HKT.Kind<
				PreparedNamespaceLambda,
				In,
				never,
				never,
				Target
			> = { built, loaded: handle, runOnLoad };
			return prepared;
		});

		const prepared = yield* mapEffectValues<
			ImplementedNamespaceLambda,
			PreparedNamespaceLambda
		>()(prepareNamespace)<Shapes>(options.namespaces);

		const preparedRecord: Readonly<
			Record<string, PreparedNamespace<NamespaceShapeTarget>>
		> = prepared;
		const registered = Object.values(preparedRecord).map(
			({ built }): RegisteredNamespace => ({
				namespace: built.namespace,
				fields: built,
			}),
		);

		yield* Effect.forEach(
			registered,
			({ fields }) => validateComputedFields(fields),
			{ concurrency: "unbounded", discard: true },
		);

		yield* Effect.forEach(
			Object.values(preparedRecord),
			({ runOnLoad }) => runOnLoad,
			{ discard: true },
		);

		const namespaces: LoadedNamespaces<Shapes> = mapValues<
			PreparedNamespaceLambda,
			LoadedNamespaceLambda
		>((preparedNamespace) => preparedNamespace.loaded)<Shapes>(prepared);

		const start = Effect.gen(function* () {
			const httpServer = yield* makeNodeHttpServer({
				onReady: options.onReady,
			});
			const ServerLive = HttpApiBuilder.serve().pipe(
				Layer.provide(websocketRoute),
				Layer.provide(
					frontendRoutes({
						namespaces: Object.values(widenedNamespaces),
						dev: options.dev ?? false,
					}),
				),
				Layer.provide(RootApiLive),
				Layer.provide(FieldRegistryService.Default(registered)),
				Layer.provide(Layer.succeed(DerivationEngineService, engine)),
				Layer.provide(HumanAuthenticationMiddlewareLive),
				Layer.provide(MachineAuthenticationMiddlewareLive),
				Layer.provide(InMemorySessionStore),
				Layer.provide(InMemoryStashStore),
				Layer.provide(InMemoryMachineClientStore),
				Layer.provide(seededRoleStore),
				Layer.provide(
					Layer.succeed(
						AuthProviderRegistry,
						// TODO: check duplicate names
						HashMap.fromIterable(
							(options.authProviders ?? []).map((provider) => [
								provider.name,
								provider,
							]),
						),
					),
				),
				Layer.provide(httpServer),
			);
			return yield* Layer.launch(ServerLive);
		});

		return { namespaces, start };
	}).pipe(
		Effect.provideService(LoadedNamespacesService, loaded),
		Effect.provide(DerivationEngineService.Default),
		Effect.provide(BuiltNamespaceRegistry.Default),
	);
});

export interface LoadedNodeCG<
	Shapes extends Record<string, BaseNamespaceShape>,
> {
	readonly namespaces: LoadedNamespaces<Shapes>;
	readonly start: () => void;
}

export const loadNodeCG = <Shapes extends Record<string, BaseNamespaceShape>>(
	options: LoadNodeCGOptions<Shapes>,
): Promise<LoadedNodeCG<Shapes>> => {
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			replicantStorage(options.storage),
			InMemoryTopicBroker,
			Layer.scope,
			Logger.pretty,
		),
	);
	return runtime
		.runPromise(loadNodeCGEffect(options))
		.then(({ namespaces, start }) => ({
			namespaces,
			start: () =>
				NodeRuntime.runMain(Effect.provide(start, runtime), {
					teardown: (exit, onExit) =>
						void runtime
							.dispose()
							.finally(() =>
								onExit(
									Exit.isFailure(exit) && !Exit.isInterrupted(exit) ? 1 : 0,
								),
							),
				}),
		}));
};
