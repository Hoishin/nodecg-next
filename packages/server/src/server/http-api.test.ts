import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { type ResolvedPermission, FieldDecodeError } from "@nodecg/core";
import {
	HumanAuthenticationMiddleware,
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
import {
	HumanAuthenticationMiddlewareLive,
	MachineAuthenticationMiddlewareLive,
} from "../auth/middleware.ts";
import { fieldRegistryLayer } from "../field-registry.ts";
import {
	type LoadedNamespace,
	FieldPermissionDenied,
	RpcCallFailed,
	type ReplicantField,
	fieldInternal,
	namespaceMetadataKey,
} from "../load-namespace.ts";
import { InMemoryMachineClientStore } from "../services/machine-client-store/in-memory-machine-client-store.ts";
import { ReplicantNotFound } from "../services/replicant-storage/replicant-storage.ts";
import { InMemoryRoleStore } from "../services/role-store/in-memory-role-store.ts";
import { InMemorySessionStore } from "../services/session-store/in-memory-session-store.ts";
import { InMemoryStashStore } from "../services/stash-store/in-memory-stash-store.ts";
import { RootApiLive } from "./http-api/build-root-api.ts";

type Internal = ReplicantField<unknown>[typeof fieldInternal];

const openPermission: ResolvedPermission = {
	read: new Set(),
	write: new Set(),
	canRead: () => true,
	canWrite: () => true,
};

function stubField(
	internal: Pick<Internal, "getEncoded" | "setEncoded">,
): ReplicantField<unknown> {
	const unused = vi.fn();
	const subscribeEncoded = () => Effect.succeed(Stream.empty);
	const subscribe = () => Effect.succeed(Stream.empty);
	return {
		get: unused,
		set: unused,
		update: unused,
		validate: unused,
		subscribe: unused,
		[fieldInternal]: {
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
		[fieldInternal]: {
			get: unused,
			subscribe: () => Effect.succeed(Stream.empty),
			getEncodedNoAuth: unused,
			getEncoded,
			subscribeEncoded: () => Effect.succeed(Stream.empty),
			permission: openPermission,
		},
	};
}

type TopicInternal = LoadedNamespace["topic"][string][typeof fieldInternal];
type RpcInternal = LoadedNamespace["rpc"][string][typeof fieldInternal];

function stubTopic(
	publishEncoded: TopicInternal["publishEncoded"],
): LoadedNamespace["topic"][string] {
	const unused = vi.fn();
	return {
		publish: unused,
		subscribe: unused,
		[fieldInternal]: {
			publish: unused,
			subscribe: () => Effect.succeed(Stream.empty),
			subscribeEncoded: () => Effect.succeed(Stream.empty),
			publishEncoded,
			permission: openPermission,
		},
	};
}

function stubRpc(
	callEncoded: RpcInternal["callEncoded"],
): LoadedNamespace["rpc"][string] {
	return {
		[fieldInternal]: {
			callEncoded,
			permission: openPermission,
		},
	};
}

function loadedNamespace(
	namespace: string,
	fields: Record<string, ReplicantField<unknown>>,
	computed: LoadedNamespace["computed"] = {},
	topic: LoadedNamespace["topic"] = {},
	rpc: LoadedNamespace["rpc"] = {},
): LoadedNamespace {
	return {
		replicant: fields,
		computed,
		topic,
		rpc,
		[namespaceMetadataKey]: { namespace },
	};
}

const asIdentity = (identity: Identity) =>
	Layer.succeed(HumanAuthenticationMiddleware, {
		cookie: () => Effect.succeed(identity),
	});

function webHandler(
	namespaces: ReadonlyArray<LoadedNamespace>,
	middleware: typeof HumanAuthenticationMiddlewareLive = HumanAuthenticationMiddlewareLive,
) {
	const { handler } = HttpApiBuilder.toWebHandler(
		Layer.mergeAll(RootApiLive, HttpServer.layerContext).pipe(
			Layer.provide(middleware),
			Layer.provide(fieldRegistryLayer(namespaces)),
			Layer.provide(MachineAuthenticationMiddlewareLive),
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
}

const getUrl = "http://x/api/internal/namespaces/root/replicant/count";
const computedUrl = "http://x/api/internal/namespaces/root/computed/count";
const topicUrl = "http://x/api/internal/namespaces/root/topic/chat";
const rpcUrl = "http://x/api/internal/namespaces/root/rpc/echo";

const putRequest = (value: unknown) =>
	new Request(getUrl, {
		method: "PUT",
		body: JSON.stringify(value),
		headers: { "content-type": "application/json" },
	});

const postRequest = (url: string, value: unknown) =>
	new Request(url, {
		method: "POST",
		body: JSON.stringify(value),
		headers: { "content-type": "application/json" },
	});

describe("me", () => {
	test("resolves an anonymous request to the anonymous identity", async () => {
		const handler = webHandler([]);
		const res = await handler(new Request("http://x/api/internal/me"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ identity: { _tag: "anonymous" } });
	});
});

describe("roles", () => {
	function rolesRequest(action: "grant" | "revoke", role: string) {
		return new Request(`http://x/api/internal/roles/${action}`, {
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

describe("machines", () => {
	const createRequest = () =>
		new Request("http://x/api/internal/machines", {
			method: "POST",
			body: JSON.stringify({ displayName: "scoreboard" }),
			headers: { "content-type": "application/json" },
		});

	const admin = asIdentity(
		HumanIdentitySchema.make({
			account: { issuer: "dev", subject: "boss", displayName: "Boss" },
			roles: new Set([RESERVED_ROLE.admin]),
		}),
	);

	test("403 for an anonymous caller", async () => {
		const handler = webHandler([]);
		expect((await handler(createRequest())).status).toBe(403);
	});

	test("mints an api key with an id and prefixed token for an admin", async () => {
		const handler = webHandler([], admin);
		const res = await handler(createRequest());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			id: expect.any(String),
			displayName: "scoreboard",
			token: expect.stringMatching(/^ncg_/),
		});
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

	test("404 when the field reports ReplicantNotFound", async () => {
		const handler = webHandler([
			loadedNamespace("root", {
				count: stubField({
					getEncoded: () =>
						Effect.fail(
							new ReplicantNotFound({ namespace: "root", name: "count" }),
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

	test("400 when the field reports FieldDecodeError", async () => {
		const handler = webHandler([
			loadedNamespace("root", {
				count: stubField({
					getEncoded: () => Effect.succeed(0),
					setEncoded: () =>
						Effect.fail(
							new FieldDecodeError({
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

	test("404 when the field reports ReplicantNotFound", async () => {
		const handler = webHandler([
			loadedNamespace("root", {
				count: stubField({
					getEncoded: () => Effect.succeed(0),
					setEncoded: () =>
						Effect.fail(
							new ReplicantNotFound({ namespace: "root", name: "count" }),
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
			new FieldPermissionDenied({
				namespace: "root",
				name: "count",
				operation: "read",
			}),
		);
	const writeDenied = () =>
		Effect.fail(
			new FieldPermissionDenied({
				namespace: "root",
				name: "count",
				operation: "write",
			}),
		);

	test("403 when replicant getEncoded denies the caller", async () => {
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

	test("403 when replicant setEncoded denies the caller", async () => {
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
		expect(await res.json()).toBe("anonymous");
	});
});

describe("topic publish", () => {
	test("forwards an allowed value and returns 204", async () => {
		const publishEncoded = vi.fn((_value: unknown) => Effect.void);
		const handler = webHandler([
			loadedNamespace("root", {}, {}, { chat: stubTopic(publishEncoded) }),
		]);
		const res = await handler(postRequest(topicUrl, 5));
		expect(res.status).toBe(204);
		expect(publishEncoded).toHaveBeenCalledWith(5);
	});

	test("404 when the namespace/name is not registered", async () => {
		const handler = webHandler([]);
		expect((await handler(postRequest(topicUrl, 5))).status).toBe(404);
	});

	test("403 when publishEncoded denies the caller", async () => {
		const handler = webHandler([
			loadedNamespace(
				"root",
				{},
				{},
				{
					chat: stubTopic(() =>
						Effect.fail(
							new FieldPermissionDenied({
								namespace: "root",
								name: "chat",
								operation: "write",
							}),
						),
					),
				},
			),
		]);
		expect((await handler(postRequest(topicUrl, 5))).status).toBe(403);
	});

	test("400 when publishEncoded reports FieldDecodeError", async () => {
		const handler = webHandler([
			loadedNamespace(
				"root",
				{},
				{},
				{
					chat: stubTopic(() =>
						Effect.fail(
							new FieldDecodeError({
								fieldName: "chat",
								value: 5,
								cause: new Error("boom"),
							}),
						),
					),
				},
			),
		]);
		expect((await handler(postRequest(topicUrl, 5))).status).toBe(400);
	});
});

describe("rpc call", () => {
	test("returns the encoded handler response", async () => {
		const handler = webHandler([
			loadedNamespace(
				"root",
				{},
				{},
				{},
				{ echo: stubRpc(() => Effect.succeed(84)) },
			),
		]);
		const res = await handler(postRequest(rpcUrl, 42));
		expect(res.status).toBe(200);
		expect(await res.json()).toBe(84);
	});

	test("404 when the proc is not registered", async () => {
		const handler = webHandler([]);
		expect((await handler(postRequest(rpcUrl, 42))).status).toBe(404);
	});

	test("403 when callEncoded denies the caller", async () => {
		const handler = webHandler([
			loadedNamespace(
				"root",
				{},
				{},
				{},
				{
					echo: stubRpc(() =>
						Effect.fail(
							new FieldPermissionDenied({
								namespace: "root",
								name: "echo",
								operation: "write",
							}),
						),
					),
				},
			),
		]);
		expect((await handler(postRequest(rpcUrl, 42))).status).toBe(403);
	});

	test("400 when callEncoded reports FieldDecodeError", async () => {
		const handler = webHandler([
			loadedNamespace(
				"root",
				{},
				{},
				{},
				{
					echo: stubRpc(() =>
						Effect.fail(
							new FieldDecodeError({
								fieldName: "echo",
								value: 42,
								cause: new Error("boom"),
							}),
						),
					),
				},
			),
		]);
		expect((await handler(postRequest(rpcUrl, 42))).status).toBe(400);
	});

	test("500 when the handler fails", async () => {
		const handler = webHandler([
			loadedNamespace(
				"root",
				{},
				{},
				{},
				{
					echo: stubRpc(() =>
						Effect.fail(
							new RpcCallFailed({
								namespace: "root",
								name: "echo",
								cause: new Error("boom"),
							}),
						),
					),
				},
			),
		]);
		expect((await handler(postRequest(rpcUrl, 42))).status).toBe(500);
	});
});

describe("public surface (v0) — always denies", () => {
	const countNamespace = () =>
		loadedNamespace("root", {
			count: stubField({
				getEncoded: () => Effect.succeed(42),
				setEncoded: () => Effect.void,
			}),
		});

	const publicGetUrl = "http://x/api/v0/namespaces/root/replicant/count";

	test("401 for a resource request without a bearer", async () => {
		const handler = webHandler([countNamespace()]);
		expect((await handler(new Request(publicGetUrl))).status).toBe(401);
	});

	test("401 for a resource request even with a bearer", async () => {
		const handler = webHandler([countNamespace()]);
		const res = await handler(
			new Request(publicGetUrl, {
				headers: { authorization: "Bearer anything" },
			}),
		);
		expect(res.status).toBe(401);
	});
});
