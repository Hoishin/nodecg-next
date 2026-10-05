import { NodeServices } from "@effect/platform-node";
import {
	type Authentication,
	CreateApiKeyResultSchema,
	sessionCookieName,
} from "@nodecg-next/internal";
import { ConfigProvider, Effect, HashMap, Layer, Option } from "effect";
import {
	Etag,
	FetchHttpClient,
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
	HttpEffect,
	HttpPlatform,
	HttpRouter,
} from "effect/unstable/http";
import { Reactivity } from "effect/unstable/reactivity";
import { assert } from "vitest";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "../src/auth/auth-provider.ts";
import { createSession } from "../src/auth/session.ts";
import { BuiltNamespaceRegistry } from "../src/build-fields.ts";
import { DerivationEngineService } from "../src/derivation-graph.ts";
import { FieldRegistryService } from "../src/field-registry.ts";
import { routes } from "../src/server/routes.ts";
import { DrizzleSqliteDatabaseService } from "../src/services/database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { OperatingSystemService } from "../src/services/operating-system/operating-system.ts";
import { AccountRepositoryService } from "../src/services/repository/account/account-repository.ts";
import { DrizzleSqliteAccountRepository } from "../src/services/repository/account/drizzle-sqlite-account-repository.ts";
import { DrizzleSqliteAuthenticationRepository } from "../src/services/repository/authentication/drizzle-sqlite-authentication-repository.ts";
import { DrizzleSqliteLoginAttemptRepository } from "../src/services/repository/login-attempt/drizzle-sqlite-login-attempt-repository.ts";
import { InMemoryReplicantRepository } from "../src/services/repository/replicant/in-memory-replicant-repository.ts";
import { DrizzleSqliteRoleRepository } from "../src/services/repository/role/drizzle-sqlite-role-repository.ts";
import { RoleRepositoryService } from "../src/services/repository/role/role-repository.ts";
import { DrizzleSqliteServiceAccountRepository } from "../src/services/repository/service-account/drizzle-sqlite-service-account-repository.ts";
import { DrizzleSqliteSessionRepository } from "../src/services/repository/session/drizzle-sqlite-session-repository.ts";
import { InMemoryTopicBroker } from "../src/services/topic-broker/in-memory-topic-broker.ts";
import { DrizzleSqliteTransaction } from "../src/services/transaction/drizzle-sqlite-transaction.ts";

export const services = Layer.mergeAll(
	DerivationEngineService.layer.pipe(
		Layer.provide(InMemoryReplicantRepository),
	),
	InMemoryTopicBroker,
	// TODO: re-use the production layer bundle by separating DatabaseService
	Layer.mergeAll(
		DrizzleSqliteLoginAttemptRepository,
		DrizzleSqliteAuthenticationRepository,
		DrizzleSqliteSessionRepository,
		DrizzleSqliteAccountRepository,
		DrizzleSqliteRoleRepository,
		DrizzleSqliteServiceAccountRepository,
		DrizzleSqliteTransaction,
	).pipe(
		Layer.provide(
			Layer.effect(
				DrizzleSqliteDatabaseService,
				DrizzleSqliteDatabaseService.make(":memory:"),
			),
		),
	),
	BuiltNamespaceRegistry.layer,
	HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak)),
	FieldRegistryService.layer([]),
	Layer.succeed(AuthProviderRegistry, HashMap.empty<string, AuthProvider>()),
	FetchHttpClient.layer,
).pipe(
	Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
	Layer.provideMerge(
		Layer.mergeAll(
			NodeServices.layer,
			OperatingSystemService.layer,
			Reactivity.layer,
		),
	),
);

export const buildClient = Effect.gen(function* () {
	const handler = yield* HttpRouter.toHttpEffect(yield* routes);
	const context = yield* Effect.context<Layer.Success<typeof services>>();
	const web = HttpEffect.toWebHandler(Effect.provide(handler, context));
	const client = yield* HttpClient.HttpClient;
	return client.pipe(
		HttpClient.transformResponse(
			Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
				web(new Request(input, init)),
			),
		),
	);
});

export const login = Effect.fn(function* (
	client: HttpClient.HttpClient,
	authentication: Authentication,
) {
	const token = yield* createSession(authentication, authentication.subject);
	return client.pipe(
		HttpClient.mapRequest(
			HttpClientRequest.setHeader("cookie", `${sessionCookieName}=${token}`),
		),
	);
});

export const findAccountId = Effect.fn(function* (
	authentication: Authentication,
) {
	const accounts = yield* AccountRepositoryService;
	const accountId = yield* accounts.resolveByAuthentication(authentication);
	assert(Option.isSome(accountId));
	return accountId.value;
});

export const loginAdmin = Effect.fn(function* (
	client: HttpClient.HttpClient,
	authentication: Authentication,
) {
	const roles = yield* RoleRepositoryService;
	const asAdmin = yield* login(client, authentication);
	yield* roles.grantGlobalRole(yield* findAccountId(authentication), "admin");
	return asAdmin;
});

export const createServiceAccount = Effect.fn(function* (
	client: HttpClient.HttpClient,
	displayName: string,
) {
	return yield* client
		.post("http://x/api/internal/service-accounts", {
			body: yield* HttpBody.json({ displayName }),
		})
		.pipe(
			Effect.flatMap(
				HttpClientResponse.schemaBodyJson(CreateApiKeyResultSchema),
			),
		);
});
