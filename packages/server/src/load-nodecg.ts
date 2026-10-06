import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { declaredRoleNames } from "@nodecg-next/core";
import type { RoleName } from "@nodecg-next/internal";
import {
	findCaseClash,
	mapEffectValues,
	mapValues,
	toError,
} from "@nodecg-next/internal/utils";
import {
	ConfigProvider,
	Effect,
	Exit,
	HashMap,
	type HKT,
	Layer,
	Logger,
	ManagedRuntime,
	Option,
	Schema,
	Scope,
} from "effect";
import { HttpRouter } from "effect/unstable/http";
import { Reactivity } from "effect/unstable/reactivity";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "./auth/auth-provider.ts";
import {
	type BuiltNamespace,
	BuiltNamespaceRegistry,
	LoadedNamespacesService,
	makeUseCross,
} from "./build-fields.ts";
import { adaptNamespace, buildNamespace } from "./build-namespace.ts";
import { fieldInternal } from "./field-builders/field-internal-key.ts";
import {
	type FrontendConfig,
	type ImplementedNamespace,
	type LoadedNamespace,
	type BaseNamespaceShape,
	type WidenedImplementedNamespace,
} from "./implement-namespace.ts";
import {
	NamespaceRegistryService,
	type RegisteredNamespace,
} from "./namespace-registry.ts";
import { ReplicantStoreService } from "./replicant-store.ts";
import { makeNodeHttpServer } from "./server/node-http-server.ts";
import { routes } from "./server/routes.ts";
import { OperatingSystemService } from "./services/operating-system/operating-system.ts";
import { DrizzleSqliteRepositories } from "./services/repository/drizzle-sqlite-repositories.ts";
import { JsonFileReplicantRepository } from "./services/repository/replicant/json-file-replicant-repository.ts";
import {
	type ReplicantRepository,
	ReplicantRepositoryService,
} from "./services/repository/replicant/replicant-repository.ts";
import { InMemoryTopicBroker } from "./services/topic-broker/in-memory-topic-broker.ts";
import { TopicBrokerService } from "./services/topic-broker/topic-broker.ts";

export type StorageOption =
	| ReplicantRepository
	| Effect.Effect<ReplicantRepository, never, never>;

export type LoadNodeCGOptions<
	Shapes extends Record<string, BaseNamespaceShape>,
> = {
	// TODO: Accept array of namespaces and use namespace names for keys
	namespaces: {
		readonly [K in keyof Shapes & string]: ImplementedNamespace<Shapes[K]>;
	};
	storage?: StorageOption;
	authProviders?: ReadonlyArray<AuthProvider>;
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

export class OnLoadError extends Schema.TaggedError<OnLoadError>()(
	"OnLoadError",
	{ namespace: Schema.String, cause: Schema.instanceOf(Error) },
) {
	override readonly message = `onLoad for namespace "${this.namespace}" failed: ${this.cause.message}`;
}

const replicantRepository = (storage: StorageOption | undefined) => {
	if (typeof storage === "undefined") {
		return JsonFileReplicantRepository;
	}
	return Effect.isEffect(storage)
		? Layer.effect(ReplicantRepositoryService, storage)
		: Layer.succeed(ReplicantRepositoryService, storage);
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
	readonly declaredRoles: ReadonlySet<RoleName>;
	readonly frontend: FrontendConfig | undefined;
	readonly runOnLoad: Effect.Effect<void, OnLoadError, Scope.Scope>;
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
	const clash = findCaseClash(loaded, []);
	if (Option.isSome(clash)) {
		return yield* Effect.die(
			new Error(
				`Namespace "${clash.value.name}" differs from "${clash.value.clash}" only in case`,
			),
		);
	}

	const internalServices = yield* Layer.build(
		Layer.merge(ReplicantStoreService.layer, BuiltNamespaceRegistry.layer),
	);

	return yield* Effect.gen(function* () {
		const context = yield* Effect.context<
			TopicBrokerService | ReplicantStoreService | BuiltNamespaceRegistry
		>();
		const store = yield* ReplicantStoreService;
		const useCross = <S extends BaseNamespaceShape>(
			implemented: ImplementedNamespace<S>,
		) => Effect.runSyncWith(context)(makeUseCross(implemented));

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
									new OnLoadError({
										namespace: implemented.manifest.namespace,
										cause: toError(error),
									}),
							});
							if (typeof cleanup === "function") {
								yield* Effect.addFinalizer(() =>
									Effect.tryPromise(async () => {
										await cleanup();
									}).pipe(
										Effect.catch((error) =>
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
			> = {
				built,
				loaded: handle,
				declaredRoles: declaredRoleNames(implemented.manifest),
				frontend: implemented.impl?.frontend,
				runOnLoad,
			};
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
			({ built, declaredRoles, frontend }): RegisteredNamespace => ({
				namespace: built.namespace,
				declaredRoles,
				frontend,
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

		const routeLayer = yield* routes;

		const httpServer = yield* makeNodeHttpServer({
			onReady: options.onReady,
		});
		const ServerLive = HttpRouter.serve(routeLayer).pipe(
			Layer.provide(NamespaceRegistryService.layer(registered)),
			Layer.provide(Layer.succeed(ReplicantStoreService, store)),
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
		const serverRequirement =
			yield* Effect.context<Layer.Services<typeof ServerLive>>();
		const start = Layer.launch(ServerLive).pipe(
			Effect.provide(serverRequirement),
			Effect.satisfiesServicesType<never>(),
		);

		return { namespaces, start };
	}).pipe(
		Effect.provideService(LoadedNamespacesService, loaded),
		Effect.provide(internalServices),
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
			replicantRepository(options.storage),
			InMemoryTopicBroker,
			DrizzleSqliteRepositories,
			Layer.effect(Scope.Scope, Effect.scope),
			Logger.layer([Logger.consolePretty()]),
		).pipe(
			Layer.provideMerge(
				ConfigProvider.layer(
					ConfigProvider.fromEnv().pipe(ConfigProvider.nested("NODECG")),
				),
			),
			Layer.provide(
				Layer.mergeAll(
					NodeServices.layer,
					OperatingSystemService.layer,
					Reactivity.layer,
				),
			),
		),
	);
	return runtime
		.runPromise(loadNodeCGEffect(options))
		.then(({ namespaces, start }) => ({
			namespaces,
			start: () =>
				NodeRuntime.runMain(start, {
					teardown: (exit, onExit) =>
						void runtime
							.dispose()
							.finally(() =>
								onExit(
									Exit.isFailure(exit) && !Exit.hasInterrupts(exit) ? 1 : 0,
								),
							),
				}),
		}));
};
