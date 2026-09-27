import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { ConfigProvider, HashMap, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { Reactivity } from "effect/unstable/reactivity";
import { describe, expect, test } from "vitest";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "../auth/auth-provider.ts";
import {
	AdminTierMiddlewareLive,
	UserAuthenticationMiddlewareLive,
	ServiceAccountAuthenticationMiddlewareLive,
	SuperadminMiddlewareLive,
} from "../auth/middleware.ts";
import { DerivationEngineService } from "../derivation-graph.ts";
import { FieldRegistryService } from "../field-registry.ts";
import { DrizzleSqliteDatabaseService } from "../services/database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { DrizzleSqliteLoginAttemptRepository } from "../services/repository/login-attempt/drizzle-sqlite-login-attempt-repository.ts";
import { InMemoryReplicantRepository } from "../services/repository/replicant/in-memory-replicant-repository.ts";
import { InMemoryRoleStore } from "../services/role-store/in-memory-role-store.ts";
import { InMemoryServiceAccountStore } from "../services/service-account-store/in-memory-service-account-store.ts";
import { InMemorySessionStore } from "../services/session-store/in-memory-session-store.ts";
import { InMemoryTopicBroker } from "../services/topic-broker/in-memory-topic-broker.ts";
import { RootApiLive } from "./http-api/build-root-api.ts";
import { UrlPath } from "./url-path.ts";
import { websocketRoute } from "./websocket.ts";

const handler = () => {
	const { handler } = HttpRouter.toWebHandler(
		Layer.mergeAll(RootApiLive, websocketRoute).pipe(
			HttpRouter.provideRequest(
				Layer.mergeAll(
					FieldRegistryService.layer([]),
					InMemoryTopicBroker,
					UrlPath.layer,
					FetchHttpClient.layer,
					DrizzleSqliteLoginAttemptRepository.pipe(
						Layer.provide(
							Layer.effect(
								DrizzleSqliteDatabaseService,
								DrizzleSqliteDatabaseService.make(":memory:"),
							),
						),
						Layer.provide(
							Layer.mergeAll(
								NodeFileSystem.layer,
								NodePath.layer,
								Reactivity.layer,
							),
						),
					),
				),
			),
			Layer.provide(UserAuthenticationMiddlewareLive),
			Layer.provide(ServiceAccountAuthenticationMiddlewareLive),
			Layer.provide(AdminTierMiddlewareLive),
			Layer.provide(SuperadminMiddlewareLive),
			Layer.provide(FieldRegistryService.layer([])),
			Layer.provide(InMemoryReplicantRepository),
			Layer.provide(InMemoryTopicBroker),
			Layer.provide(
				DerivationEngineService.layer.pipe(
					Layer.provide(InMemoryReplicantRepository),
				),
			),
			Layer.provide(InMemorySessionStore),
			Layer.provide(InMemoryRoleStore),
			Layer.provide(InMemoryServiceAccountStore),
			Layer.provide(
				Layer.succeed(
					AuthProviderRegistry,
					HashMap.empty<string, AuthProvider>(),
				),
			),
			Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
			Layer.provide(HttpServer.layerServices),
		),
	);
	return handler;
};

describe("public streaming surface (/ws/v0)", () => {
	test("401 without a bearer", async () => {
		const res = await handler()(new Request("http://x/ws/v0"));
		expect(res.status).toBe(401);
	});

	test("401 with an unknown bearer", async () => {
		const res = await handler()(
			new Request("http://x/ws/v0", {
				headers: { authorization: "Bearer ncg_nope" },
			}),
		);
		expect(res.status).toBe(401);
	});
});

describe("first-party streaming surface (/ws/internal)", () => {
	test("does not 401 an anonymous request when auth is not required", async () => {
		const res = await handler()(new Request("http://x/ws/internal"));
		expect(res.status).not.toBe(401);
	});
});
