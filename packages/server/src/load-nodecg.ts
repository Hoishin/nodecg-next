import { HttpApiBuilder } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { toError } from "@nodecg/internal/utils";
import {
	Data,
	Effect,
	Exit,
	HashMap,
	Layer,
	Logger,
	ManagedRuntime,
	Runtime,
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
	LoadedNamespacesService,
	NamespaceNotLoaded,
} from "./build-fields.ts";
import { buildNamespace, useNamespace } from "./build-namespace.ts";
import { fieldInternal } from "./field-builders/field-internal-key.ts";
import {
	FieldRegistryService,
	type RegisteredNamespace,
} from "./field-registry.ts";
import {
	type ImplementedNamespace,
	type UseNamespace,
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

export type LoadNodeCGOptions = {
	namespaces: ReadonlyArray<ImplementedNamespace<{}, {}, {}, {}>>;
	storage?: StorageOption;
	authProviders?: ReadonlyArray<AuthProvider>;
	dev?: boolean;
	onReady?: () => void;
	/**
	 * TODO: remove this once we have superadmin seeding
	 * */
	superadmins?: ReadonlyArray<{
		readonly issuer: string;
		readonly subject: string;
	}>;
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

const buildNamespaces = Effect.fn("buildNamespaces")(function* (
	namespaces: ReadonlyArray<ImplementedNamespace<{}, {}, {}, {}>>,
) {
	const seen = new Set<string>();
	for (const { manifest } of namespaces) {
		if (seen.has(manifest.namespace)) {
			return yield* Effect.die(
				new Error(`Namespace "${manifest.namespace}" was loaded twice`),
			);
		}
		seen.add(manifest.namespace);
	}
	return yield* Effect.forEach(
		namespaces,
		Effect.fn(function* ({ manifest, impl }) {
			const fields = yield* buildNamespace(manifest, impl);
			const registered: RegisteredNamespace = {
				namespace: manifest.namespace,
				fields,
			};
			return registered;
		}),
	);
});

/**
 * On startup, validate all computed fields against schema
 */
const validateComputedFields = (built: BuiltNamespace) =>
	Effect.forEach(
		Object.values(built.computed),
		(field) => field[fieldInternal].getEncodedNoAuth(),
		{ concurrency: "unbounded", discard: true },
	);

const runOnLoad = (
	namespaces: ReadonlyArray<ImplementedNamespace<{}, {}, {}, {}>>,
	use: UseNamespace,
) =>
	Effect.forEach(
		namespaces,
		Effect.fn(function* ({ manifest, impl }) {
			const onLoad = impl?.onLoad;
			if (typeof onLoad === "undefined") {
				return;
			}
			const cleanup = yield* Effect.tryPromise({
				try: async () => onLoad({ ...use({ manifest, impl }), use }),
				catch: (error) =>
					new OnLoadFailed({
						namespace: manifest.namespace,
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
								`onLoad cleanup for namespace "${manifest.namespace}" threw`,
								error,
							),
						),
					),
				);
			}
		}),
		{ discard: true },
	);

export const loadNodeCGEffect = Effect.fn("loadNodeCGEffect")(function* (
	options: LoadNodeCGOptions,
) {
	const loaded = new Set(
		options.namespaces.map(({ manifest }) => manifest.namespace),
	);
	return yield* Effect.gen(function* () {
		const built = yield* buildNamespaces(options.namespaces);

		yield* Effect.forEach(
			built,
			({ fields }) => validateComputedFields(fields),
			{ concurrency: "unbounded", discard: true },
		);

		const runtime = yield* Effect.runtime<
			ReplicantStorageService | TopicBrokerService
		>();
		const use: UseNamespace = (implemented) => {
			if (!loaded.has(implemented.manifest.namespace)) {
				throw new NamespaceNotLoaded({
					namespace: implemented.manifest.namespace,
				});
			}
			return Runtime.runSync(runtime, useNamespace(implemented));
		};

		yield* runOnLoad(options.namespaces, use);

		const start = Effect.gen(function* () {
			const httpServer = yield* makeNodeHttpServer({
				onReady: options.onReady,
			});
			const ServerLive = HttpApiBuilder.serve().pipe(
				Layer.provide(websocketRoute),
				Layer.provide(
					frontendRoutes({
						namespaces: options.namespaces,
						dev: options.dev ?? false,
					}),
				),
				Layer.provide(RootApiLive),
				Layer.provide(FieldRegistryService.Default(built)),
				Layer.provide(HumanAuthenticationMiddlewareLive),
				Layer.provide(MachineAuthenticationMiddlewareLive),
				Layer.provide(InMemorySessionStore),
				Layer.provide(InMemoryStashStore),
				Layer.provide(InMemoryMachineClientStore),
				Layer.provide(seededRoleStore(options.superadmins ?? [])),
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

		return { use, start };
	}).pipe(Effect.provideService(LoadedNamespacesService, loaded));
});

export interface LoadedNodeCG {
	readonly use: UseNamespace;
	readonly start: () => void;
}

export const loadNodeCG = (
	options: LoadNodeCGOptions,
): Promise<LoadedNodeCG> => {
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
		.then(({ use, start }) => ({
			use,
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
