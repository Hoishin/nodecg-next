import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { HashMap, Layer } from "effect";
import { describe, expect, test } from "vitest";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "../auth/auth-provider.ts";
import {
	HumanAuthenticationMiddlewareLive,
	MachineAuthenticationMiddlewareLive,
} from "../auth/middleware.ts";
import { DerivationEngineService } from "../derivation-graph.ts";
import { FieldRegistryService } from "../field-registry.ts";
import { InMemoryMachineClientStore } from "../services/machine-client-store/in-memory-machine-client-store.ts";
import { InMemoryReplicantStorage } from "../services/replicant-storage/in-memory-replicant-storage.ts";
import { InMemoryRoleStore } from "../services/role-store/in-memory-role-store.ts";
import { InMemorySessionStore } from "../services/session-store/in-memory-session-store.ts";
import { InMemoryStashStore } from "../services/stash-store/in-memory-stash-store.ts";
import { InMemoryTopicBroker } from "../services/topic-broker/in-memory-topic-broker.ts";
import { RootApiLive } from "./http-api/build-root-api.ts";
import { websocketRoute } from "./websocket.ts";

const handler = () => {
	const { handler } = HttpApiBuilder.toWebHandler(
		Layer.mergeAll(RootApiLive, websocketRoute, HttpServer.layerContext).pipe(
			Layer.provide(HumanAuthenticationMiddlewareLive),
			Layer.provide(MachineAuthenticationMiddlewareLive),
			Layer.provide(FieldRegistryService.Default([])),
			Layer.provide(InMemoryReplicantStorage),
			Layer.provide(InMemoryTopicBroker),
			Layer.provide(DerivationEngineService.Default),
			Layer.provide(InMemorySessionStore),
			Layer.provide(InMemoryStashStore),
			Layer.provide(InMemoryRoleStore),
			Layer.provide(InMemoryMachineClientStore),
			Layer.provide(
				Layer.succeed(
					AuthProviderRegistry,
					HashMap.empty<string, AuthProvider>(),
				),
			),
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
