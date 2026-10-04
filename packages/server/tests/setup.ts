import { NodeServices } from "@effect/platform-node";
import { sessionCookieName } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { ConfigProvider, Effect, HashMap, Layer } from "effect";
import {
	Etag,
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpEffect,
	HttpPlatform,
	HttpRouter,
} from "effect/unstable/http";
import { Reactivity } from "effect/unstable/reactivity";

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
import { DrizzleSqliteAccountRepository } from "../src/services/repository/account/drizzle-sqlite-account-repository.ts";
import { AuthenticationRepositoryService } from "../src/services/repository/authentication/authentication-repository.ts";
import { DrizzleSqliteAuthenticationRepository } from "../src/services/repository/authentication/drizzle-sqlite-authentication-repository.ts";
import { DrizzleSqliteLoginAttemptRepository } from "../src/services/repository/login-attempt/drizzle-sqlite-login-attempt-repository.ts";
import { InMemoryReplicantRepository } from "../src/services/repository/replicant/in-memory-replicant-repository.ts";
import { DrizzleSqliteRoleRepository } from "../src/services/repository/role/drizzle-sqlite-role-repository.ts";
import { DrizzleSqliteServiceAccountRepository } from "../src/services/repository/service-account/drizzle-sqlite-service-account-repository.ts";
import { DrizzleSqliteSessionRepository } from "../src/services/repository/session/drizzle-sqlite-session-repository.ts";
import { InMemoryTopicBroker } from "../src/services/topic-broker/in-memory-topic-broker.ts";
import { DrizzleSqliteTransaction } from "../src/services/transaction/drizzle-sqlite-transaction.ts";

const services = Layer.mergeAll(
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

export const test = testLayer(services);

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

export const createAccount = Effect.fn(function* (
	issuer: string,
	subject: string,
) {
	const authentications = yield* AuthenticationRepositoryService;
	const { accountId } = yield* authentications.findOrCreateAuthentication(
		{ issuer, subject },
		subject,
	);
	return accountId;
});

export const login = (issuer: string, subject: string) =>
	Effect.fn(function* (client: HttpClient.HttpClient) {
		const token = yield* createSession({ issuer, subject }, subject);
		return client.pipe(
			HttpClient.mapRequest(
				HttpClientRequest.setHeader("cookie", `${sessionCookieName}=${token}`),
			),
		);
	});
