import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { StateDecodeError } from "@nodecg/core";
import { Effect, HashMap, Layer, Stream } from "effect";
import { describe, expect, test, vi } from "vitest";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "../auth/auth-provider.ts";
import {
	type LoadedNamespace,
	type StateField,
	stateFieldInternal,
	stateMetadataKey,
} from "../load-namespace.ts";
import { InMemoryRoleStore } from "../services/role-store/in-memory-role-store.ts";
import { InMemorySessionStore } from "../services/session-store/in-memory-session-store.ts";
import { InMemoryStashStore } from "../services/stash-store/in-memory-stash-store.ts";
import { StateNotFound } from "../services/state-storage/state-storage.ts";
import { buildNodecgApi } from "./http-api.ts";

type Internal = StateField<unknown>[typeof stateFieldInternal];

function stubField(
	internal: Pick<Internal, "getEncoded" | "setEncoded">,
): StateField<unknown> {
	const unused = vi.fn();
	const subscribeEncoded = () => Effect.succeed(Stream.empty);
	const subscribe = () => Effect.succeed(Stream.empty);
	return {
		get: unused,
		set: unused,
		update: unused,
		validate: unused,
		subscribe: unused,
		[stateFieldInternal]: {
			get: unused,
			set: unused,
			update: unused,
			validate: unused,
			subscribe,
			getEncoded: internal.getEncoded,
			setEncoded: internal.setEncoded,
			subscribeEncoded,
		},
	};
}

function stubComputed(
	getEncoded: Internal["getEncoded"],
): LoadedNamespace["computed"][string] {
	const unused = vi.fn();
	return {
		get: unused,
		subscribe: unused,
		[stateFieldInternal]: {
			get: unused,
			subscribe: () => Effect.succeed(Stream.empty),
			getEncoded,
			subscribeEncoded: () => Effect.succeed(Stream.empty),
		},
	};
}

function loadedNamespace(
	namespace: string,
	fields: Record<string, StateField<unknown>>,
	computed: LoadedNamespace["computed"] = {},
): LoadedNamespace {
	return {
		state: fields,
		computed,
		[stateMetadataKey]: { namespace },
	};
}

function webHandler(namespaces: ReadonlyArray<LoadedNamespace>) {
	const { handler } = HttpApiBuilder.toWebHandler(
		Layer.mergeAll(
			buildNodecgApi({ namespaces }),
			HttpServer.layerContext,
		).pipe(
			Layer.provide(InMemorySessionStore),
			Layer.provide(InMemoryStashStore),
			Layer.provide(InMemoryRoleStore),
			Layer.provide(
				Layer.succeed(
					AuthProviderRegistry,
					HashMap.empty<string, AuthProvider>(),
				),
			),
		),
	);
	return handler;
}

const getUrl = "http://x/api/namespaces/root/state/count";
const computedUrl = "http://x/api/namespaces/root/computed/count";

describe("ping", () => {
	test("returns pong", async () => {
		const handler = webHandler([]);
		const res = await handler(new Request("http://x/api/ping"));
		expect(res.status).toBe(200);
		expect(await res.json()).toBe("pong");
	});
});

describe("me", () => {
	test("resolves an anonymous request to the public identity", async () => {
		const handler = webHandler([]);
		const res = await handler(new Request("http://x/api/me"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ identity: { _tag: "public" } });
	});
});

describe("roles", () => {
	function rolesRequest(action: "grant" | "revoke", role: string) {
		return new Request(`http://x/api/roles/${action}`, {
			method: "POST",
			body: JSON.stringify({ issuer: "dev", subject: "operator", role }),
			headers: { "content-type": "application/json" },
		});
	}

	test("grant returns the updated set, revoke removes it", async () => {
		const handler = webHandler([]);
		const grant = await handler(rolesRequest("grant", "superadmin"));
		expect(grant.status).toBe(200);
		expect(await grant.json()).toEqual({ roles: ["superadmin"] });

		const revoke = await handler(rolesRequest("revoke", "superadmin"));
		expect(revoke.status).toBe(200);
		expect(await revoke.json()).toEqual({ roles: [] });
	});

	test("accepts an arbitrary named role", async () => {
		const handler = webHandler([]);
		const grant = await handler(rolesRequest("grant", "producer"));
		expect(grant.status).toBe(200);
		expect(await grant.json()).toEqual({ roles: ["producer"] });
	});
});

describe("get", () => {
	test("returns the stored value", async () => {
		const handler = webHandler([
			loadedNamespace("root", {
				count: stubField({
					getEncoded: () => Effect.succeed(42),
					setEncoded: () => Effect.void,
				}),
			}),
		]);
		const res = await handler(new Request(getUrl));
		expect(res.status).toBe(200);
		expect(await res.json()).toBe(42);
	});

	test("404 when the namespace/name is not registered", async () => {
		const handler = webHandler([]);
		const res = await handler(new Request(getUrl));
		expect(res.status).toBe(404);
	});

	test("404 when the field reports StateNotFound", async () => {
		const handler = webHandler([
			loadedNamespace("root", {
				count: stubField({
					getEncoded: () =>
						Effect.fail(
							new StateNotFound({ namespace: "root", name: "count" }),
						),
					setEncoded: () => Effect.void,
				}),
			}),
		]);
		const res = await handler(new Request(getUrl));
		expect(res.status).toBe(404);
	});

	test("returns a computed field's value", async () => {
		const handler = webHandler([
			loadedNamespace(
				"root",
				{},
				{ count: stubComputed(() => Effect.succeed(84)) },
			),
		]);
		const res = await handler(new Request(computedUrl));
		expect(res.status).toBe(200);
		expect(await res.json()).toBe(84);
	});
});

describe("update", () => {
	function putRequest(value: unknown) {
		return new Request(getUrl, {
			method: "PUT",
			body: JSON.stringify(value),
			headers: { "content-type": "application/json" },
		});
	}

	test("stores the decoded payload and returns 204", async () => {
		const setEncoded = vi.fn((_value: unknown) => Effect.void);
		const handler = webHandler([
			loadedNamespace("root", {
				count: stubField({ getEncoded: () => Effect.succeed(0), setEncoded }),
			}),
		]);
		const res = await handler(putRequest(7));
		expect(res.status).toBe(204);
		expect(setEncoded).toHaveBeenCalledWith(7);
	});

	test("404 when the namespace/name is not registered", async () => {
		const handler = webHandler([]);
		const res = await handler(putRequest(7));
		expect(res.status).toBe(404);
	});

	test("400 when the field reports StateDecodeError", async () => {
		const handler = webHandler([
			loadedNamespace("root", {
				count: stubField({
					getEncoded: () => Effect.succeed(0),
					setEncoded: () =>
						Effect.fail(
							new StateDecodeError({
								fieldName: "count",
								value: 7,
								cause: new Error("boom"),
							}),
						),
				}),
			}),
		]);
		const res = await handler(putRequest(7));
		expect(res.status).toBe(400);
	});

	test("404 when the field reports StateNotFound", async () => {
		const handler = webHandler([
			loadedNamespace("root", {
				count: stubField({
					getEncoded: () => Effect.succeed(0),
					setEncoded: () =>
						Effect.fail(
							new StateNotFound({ namespace: "root", name: "count" }),
						),
				}),
			}),
		]);
		const res = await handler(putRequest(7));
		expect(res.status).toBe(404);
	});
});
