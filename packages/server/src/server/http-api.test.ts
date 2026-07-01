import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { type ResolvedPermission, StateDecodeError } from "@nodecg/core";
import {
	AuthenticationMiddleware,
	CurrentIdentity,
	HumanIdentitySchema,
	type Identity,
	RESERVED_ROLE,
	RoleName,
} from "@nodecg/internal";
import { Effect, HashMap, Layer, Stream } from "effect";
import { describe, expect, test, vi } from "vitest";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "../auth/auth-provider.ts";
import { AuthenticationMiddlewareLive } from "../auth/middleware.ts";
import {
	type LoadedNamespace,
	PermissionDenied,
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

const openPermission: ResolvedPermission = {
	read: new Set(),
	write: new Set(),
	canRead: () => true,
	canWrite: () => true,
};

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
			getEncodedNoAuth: unused,
			getEncoded: internal.getEncoded,
			setEncoded: internal.setEncoded,
			subscribeEncoded,
			permission: openPermission,
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
			getEncodedNoAuth: unused,
			getEncoded,
			subscribeEncoded: () => Effect.succeed(Stream.empty),
			permission: openPermission,
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

const asIdentity = (identity: Identity) =>
	Layer.succeed(AuthenticationMiddleware, Effect.succeed(identity));

function webHandler(
	namespaces: ReadonlyArray<LoadedNamespace>,
	middleware: typeof AuthenticationMiddlewareLive = AuthenticationMiddlewareLive,
) {
	const { handler } = HttpApiBuilder.toWebHandler(
		Layer.mergeAll(
			buildNodecgApi({ namespaces }),
			HttpServer.layerContext,
		).pipe(
			Layer.provide(middleware),
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

const putRequest = (value: unknown) =>
	new Request(getUrl, {
		method: "PUT",
		body: JSON.stringify(value),
		headers: { "content-type": "application/json" },
	});

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

	const admin = asIdentity(
		HumanIdentitySchema.make({
			account: { issuer: "dev", subject: "boss", displayName: "Boss" },
			roles: new Set([RESERVED_ROLE.admin]),
		}),
	);

	test("403 for an anonymous caller", async () => {
		const handler = webHandler([]);
		expect((await handler(rolesRequest("grant", "superadmin"))).status).toBe(
			403,
		);
		expect((await handler(rolesRequest("revoke", "superadmin"))).status).toBe(
			403,
		);
	});

	test("403 for a named-role caller without the admin tier", async () => {
		const handler = webHandler(
			[],
			asIdentity(
				HumanIdentitySchema.make({
					account: { issuer: "dev", subject: "op", displayName: "Op" },
					roles: new Set([RoleName("producer")]),
				}),
			),
		);
		expect((await handler(rolesRequest("grant", "superadmin"))).status).toBe(
			403,
		);
	});

	test("grant returns the updated set, revoke removes it for an admin", async () => {
		const handler = webHandler([], admin);
		const grant = await handler(rolesRequest("grant", "superadmin"));
		expect(grant.status).toBe(200);
		expect(await grant.json()).toEqual({ roles: ["superadmin"] });

		const revoke = await handler(rolesRequest("revoke", "superadmin"));
		expect(revoke.status).toBe(200);
		expect(await revoke.json()).toEqual({ roles: [] });
	});

	test("accepts an arbitrary named role", async () => {
		const handler = webHandler([], admin);
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

describe("permission enforcement", () => {
	const readDenied = () =>
		Effect.fail(
			new PermissionDenied({
				namespace: "root",
				name: "count",
				operation: "read",
			}),
		);
	const writeDenied = () =>
		Effect.fail(
			new PermissionDenied({
				namespace: "root",
				name: "count",
				operation: "write",
			}),
		);

	test("403 when state getEncoded denies the caller", async () => {
		const handler = webHandler([
			loadedNamespace("root", {
				count: stubField({
					getEncoded: readDenied,
					setEncoded: () => Effect.void,
				}),
			}),
		]);
		const res = await handler(new Request(getUrl));
		expect(res.status).toBe(403);
	});

	test("403 when state setEncoded denies the caller", async () => {
		const setEncoded = vi.fn(writeDenied);
		const handler = webHandler([
			loadedNamespace("root", {
				count: stubField({ getEncoded: () => Effect.succeed(0), setEncoded }),
			}),
		]);
		const res = await handler(putRequest(7));
		expect(res.status).toBe(403);
	});

	test("403 when computed getEncoded denies the caller", async () => {
		const handler = webHandler([
			loadedNamespace("root", {}, { count: stubComputed(readDenied) }),
		]);
		const res = await handler(new Request(computedUrl));
		expect(res.status).toBe(403);
	});

	test("runs the encoded op with the resolved identity in context", async () => {
		const getEncoded = () =>
			CurrentIdentity.pipe(Effect.map((identity) => identity._tag));
		const handler = webHandler([
			loadedNamespace("root", {
				count: stubField({ getEncoded, setEncoded: () => Effect.void }),
			}),
		]);
		const res = await handler(new Request(getUrl));
		expect(await res.json()).toBe("public");
	});
});
