import { HttpApiBuilder } from "@effect/platform";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, HashMap, Layer } from "effect";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "./auth/auth-provider.ts";
import {
	MachineAuthenticationMiddlewareLive,
	HumanAuthenticationMiddlewareLive,
} from "./auth/middleware.ts";
import { buildNamespace } from "./build-namespace.ts";
import {
	fieldRegistryLayer,
	type RegisteredNamespace,
} from "./field-registry.ts";
import { type ImplementedNamespace } from "./implement-namespace.ts";
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

const storageLayer = (storage: StorageOption | undefined) => {
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

export const loadNodeCGEffect = Effect.fn("loadNodeCGEffect")(function* (
	options: LoadNodeCGOptions,
) {
	return yield* Effect.gen(function* () {
		const built = yield* buildNamespaces(options.namespaces);

		const ServerLive = HttpApiBuilder.serve().pipe(
			Layer.provide(websocketRoute),
			Layer.provide(
				frontendRoutes({
					namespaces: options.namespaces,
					dev: options.dev ?? false,
				}),
			),
			Layer.provide(RootApiLive),
			Layer.provide(fieldRegistryLayer(built)),
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
			Layer.provide(yield* makeNodeHttpServer({ onReady: options.onReady })),
		);

		return yield* Layer.launch(ServerLive);
	}).pipe(
		Effect.provide(
			Layer.merge(storageLayer(options.storage), InMemoryTopicBroker),
		),
	);
});

export const loadNodeCG = (options: LoadNodeCGOptions) =>
	loadNodeCGEffect(options).pipe(Effect.scoped, NodeRuntime.runMain);
