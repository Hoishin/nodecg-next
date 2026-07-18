import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { type ResolvedPermission, FieldDecodeError } from "@nodecg/core";
import {
	HumanAuthenticationMiddleware,
	AnonymousIdentitySchema,
	CurrentIdentity,
	HumanIdentitySchema,
	type Identity,
	ADMIN_ROLE,
	RoleName,
} from "@nodecg/internal";
import {
	ConfigProvider,
	Effect,
	HashMap,
	Layer,
	Redacted,
	Schema,
	Stream,
} from "effect";
import { describe, expect, test, vi } from "vitest";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "../auth/auth-provider.ts";
import {
	HumanAuthenticationMiddlewareLive,
	MachineAuthenticationMiddlewareLive,
} from "../auth/middleware.ts";
import { type BuiltNamespace } from "../build-fields.ts";
import {
	DerivationEngineService,
	ReplicantNotFound2,
} from "../derivation-graph.ts";
import { RpcCallFailed } from "../field-builders/build-rpc.ts";
import { fieldInternal } from "../field-builders/field-internal-key.ts";
import { FieldPermissionDenied } from "../field-builders/permission.ts";
import {
	FieldRegistryService,
	type RegisteredNamespace,
} from "../field-registry.ts";
import { InMemoryMachineClientStore } from "../services/machine-client-store/in-memory-machine-client-store.ts";
import { InMemoryReplicantStorage } from "../services/replicant-storage/in-memory-replicant-storage.ts";
import { ReplicantNotFound } from "../services/replicant-storage/replicant-storage.ts";
import { InMemoryRoleStore } from "../services/role-store/in-memory-role-store.ts";
import { InMemorySessionStore } from "../services/session-store/in-memory-session-store.ts";
import { InMemoryStashStore } from "../services/stash-store/in-memory-stash-store.ts";
import { InMemoryTopicBroker } from "../services/topic-broker/in-memory-topic-broker.ts";
import { RootApiLive } from "./http-api/build-root-api.ts";

type ReplicantStub = BuiltNamespace["replicant"][string];
type Internal = ReplicantStub[typeof fieldInternal];

const openPermission: ResolvedPermission = {
	read: { roles: new Set(), rolesDenied: new Set() },
	write: { roles: new Set(), rolesDenied: new Set() },
	canRead: () => true,
	canWrite: () => true,
};

function stubField(
	internal: Pick<Internal, "getEncoded" | "setEncoded">,
): ReplicantStub {
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
			getEncoded: internal.getEncoded,
			setEncoded: internal.setEncoded,
			subscribeEncoded,
			permission: openPermission,
		},
	};
}

type ComputedInternal =
	BuiltNamespace["computed"][string][typeof fieldInternal];

function stubComputed(
	getEncoded: ComputedInternal["getEncoded"],
): BuiltNamespace["computed"][string] {
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

type TopicInternal = BuiltNamespace["topic"][string][typeof fieldInternal];
type RpcInternal = BuiltNamespace["rpc"][string][typeof fieldInternal];

function stubTopic(
	publishEncoded: TopicInternal["publishEncoded"],
): BuiltNamespace["topic"][string] {
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
): BuiltNamespace["rpc"][string] {
	return {
		call: vi.fn(),
		[fieldInternal]: {
			callEncoded,
			permission: openPermission,
		},
	};
}

function registeredNamespace(
	namespace: string,
	replicant: Record<string, ReplicantStub>,
	computed: BuiltNamespace["computed"] = {},
	topic: BuiltNamespace["topic"] = {},
	rpc: BuiltNamespace["rpc"] = {},
): RegisteredNamespace {
	return { namespace, fields: { replicant, computed, topic, rpc } };
}

const asIdentity = (identity: Identity) =>
	Layer.succeed(HumanAuthenticationMiddleware, {
		cookie: () => Effect.succeed(identity),
	});

function webHandler(
	namespaces: ReadonlyArray<RegisteredNamespace>,
	middleware: typeof HumanAuthenticationMiddlewareLive = HumanAuthenticationMiddlewareLive,
	environment: Layer.Layer<never> = Layer.empty,
) {
	const { handler } = HttpApiBuilder.toWebHandler(
		Layer.mergeAll(RootApiLive, HttpServer.layerContext).pipe(
			Layer.provide(middleware),
			Layer.provide(FieldRegistryService.Default(namespaces)),
			Layer.provide(MachineAuthenticationMiddlewareLive),
			Layer.provide(InMemorySessionStore),
			Layer.provide(InMemoryStashStore),
			Layer.provide(InMemoryRoleStore),
			Layer.provide(InMemoryMachineClientStore),
			Layer.provide(InMemoryReplicantStorage),
			Layer.provide(InMemoryTopicBroker),
			Layer.provide(DerivationEngineService.Default),
			Layer.provide(
				Layer.succeed(
					AuthProviderRegistry,
					HashMap.empty<string, AuthProvider>(),
				),
			),
			Layer.provide(environment),
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
			roles: new Set([ADMIN_ROLE.admin]),
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
		const grant = await handler(rolesRequest("grant", "producer"));
		expect(grant.status).toBe(200);
		expect(await grant.json()).toEqual({ roles: ["producer"] });

		const revoke = await handler(rolesRequest("revoke", "producer"));
		expect(revoke.status).toBe(200);
		expect(await revoke.json()).toEqual({ roles: [] });
	});

	test("403 when an admin grants an undeclarable role", async () => {
		const handler = webHandler([], admin);
		expect((await handler(rolesRequest("grant", "superadmin"))).status).toBe(
			403,
		);
		expect((await handler(rolesRequest("grant", "admin"))).status).toBe(403);
		expect((await handler(rolesRequest("grant", "server"))).status).toBe(403);
	});
});

describe("claim superadmin", () => {
	const claimUrl = "http://x/api/internal/authentication/claim-superadmin";
	const claimRequest = (token: string) => postRequest(claimUrl, { token });

	const human = asIdentity(
		HumanIdentitySchema.make({
			account: { issuer: "dev", subject: "founder", displayName: "Founder" },
			roles: new Set(),
		}),
	);

	const withClaimToken = Layer.setConfigProvider(
		ConfigProvider.fromMap(
			new Map([["SUPERADMIN_CLAIM_TOKEN", "super-secret-claim-token"]]),
		),
	);

	test("grants superadmin to the logged-in human presenting the token", async () => {
		const handler = webHandler([], human, withClaimToken);
		const res = await handler(claimRequest("super-secret-claim-token"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ roles: ["superadmin"] });
	});

	test("403 for a wrong token, without closing the window", async () => {
		const handler = webHandler([], human, withClaimToken);
		expect(
			(await handler(claimRequest("wrong-token-of-real-length"))).status,
		).toBe(403);
		expect(
			(await handler(claimRequest("super-secret-claim-token"))).status,
		).toBe(200);
	});

	test("403 for an anonymous caller", async () => {
		const handler = webHandler([], undefined, withClaimToken);
		expect(
			(await handler(claimRequest("super-secret-claim-token"))).status,
		).toBe(403);
	});

	test("403 when no claim token is configured", async () => {
		const handler = webHandler([], human);
		expect(
			(await handler(claimRequest("super-secret-claim-token"))).status,
		).toBe(403);
	});

	test("the first successful claim closes the window", async () => {
		const handler = webHandler([], human, withClaimToken);
		expect(
			(await handler(claimRequest("super-secret-claim-token"))).status,
		).toBe(200);
		expect(
			(await handler(claimRequest("super-secret-claim-token"))).status,
		).toBe(403);
	});

	test("429 after too many attempts in the window", async () => {
		const handler = webHandler([], human, withClaimToken);
		for (let attempt = 0; attempt < 5; attempt++) {
			expect(
				(await handler(claimRequest("wrong-token-of-real-length"))).status,
			).toBe(403);
		}
		expect(
			(await handler(claimRequest("super-secret-claim-token"))).status,
		).toBe(429);
	});

	test("an anonymous flood does not consume the claim budget", async () => {
		const bySid = Layer.succeed(HumanAuthenticationMiddleware, {
			cookie: (sid: Redacted.Redacted<string>) =>
				Effect.succeed(
					Redacted.value(sid) === "founder"
						? HumanIdentitySchema.make({
								account: {
									issuer: "dev",
									subject: "founder",
									displayName: "Founder",
								},
								roles: new Set(),
							})
						: AnonymousIdentitySchema.make(),
				),
		});
		const handler = webHandler([], bySid, withClaimToken);
		const withSid = (request: Request, sid: string) => {
			request.headers.set("cookie", `nodecg.sid=${sid}`);
			return request;
		};
		for (let attempt = 0; attempt < 10; attempt++) {
			expect(
				(await handler(claimRequest("super-secret-claim-token"))).status,
			).toBe(403);
		}
		expect(
			(
				await handler(
					withSid(claimRequest("super-secret-claim-token"), "founder"),
				)
			).status,
		).toBe(200);
	});
});

describe("roles export/import", () => {
	const founderIdentity = HumanIdentitySchema.make({
		account: { issuer: "dev", subject: "founder", displayName: "Founder" },
		roles: new Set(),
	});
	const adminIdentity = HumanIdentitySchema.make({
		account: { issuer: "dev", subject: "boss", displayName: "Boss" },
		roles: new Set([ADMIN_ROLE.admin]),
	});
	const admin = asIdentity(adminIdentity);

	const identityBySubject = (identities: Record<string, Identity>) =>
		Layer.succeed(HumanAuthenticationMiddleware, {
			cookie: (sid: Redacted.Redacted<string>) =>
				Effect.succeed(
					identities[Redacted.value(sid)] ?? AnonymousIdentitySchema.make(),
				),
		});

	// The admin tier can only enter the store by claim or seed — grant and import both refuse it.
	const tiered = identityBySubject({
		founder: founderIdentity,
		boss: adminIdentity,
	});

	const withClaimToken = Layer.setConfigProvider(
		ConfigProvider.fromMap(
			new Map([["SUPERADMIN_CLAIM_TOKEN", "super-secret-claim-token"]]),
		),
	);

	const claimRequest = () =>
		postRequest("http://x/api/internal/authentication/claim-superadmin", {
			token: "super-secret-claim-token",
		});

	const withSid = (request: Request, sid: string) => {
		request.headers.set("cookie", `nodecg.sid=${sid}`);
		return request;
	};

	const exportRequest = () => new Request("http://x/api/internal/roles/export");

	const importRequest = (
		mode: "replace" | "merge",
		assignments: ReadonlyArray<unknown>,
	) =>
		postRequest("http://x/api/internal/roles/import", {
			mode,
			document: { version: 0, assignments },
		});

	const grantRequest = (subject: string, role: string) =>
		postRequest("http://x/api/internal/roles/grant", {
			issuer: "dev",
			subject,
			role,
		});

	const createMachineRequest = (displayName: string) =>
		postRequest("http://x/api/internal/machines", { displayName });

	const machineRoleRequest = (id: string, role: string) =>
		postRequest(`http://x/api/internal/machines/${id}/roles`, { role });

	const listMachinesRequest = () =>
		new Request("http://x/api/internal/machines");

	const decodeId = Schema.decodeUnknownSync(
		Schema.Struct({ id: Schema.String }),
	);

	const decodeRoles = Schema.decodeUnknownSync(
		Schema.Struct({ roles: Schema.Array(Schema.String) }),
	);

	const decodeImportError = Schema.decodeUnknownSync(
		Schema.Struct({ message: Schema.String }),
	);

	test("403 for an anonymous caller", async () => {
		const handler = webHandler([]);
		expect((await handler(exportRequest())).status).toBe(403);
		expect((await handler(importRequest("merge", []))).status).toBe(403);
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
		expect((await handler(exportRequest())).status).toBe(403);
		expect((await handler(importRequest("merge", []))).status).toBe(403);
	});

	test("exports human and machine assignments for an admin", async () => {
		const handler = webHandler([], admin);
		await handler(grantRequest("operator", "producer"));
		const { id } = decodeId(
			await (await handler(createMachineRequest("scoreboard"))).json(),
		);
		await handler(machineRoleRequest(id, "viewer"));
		await handler(createMachineRequest("idle"));
		const res = await handler(exportRequest());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			version: 0,
			assignments: [
				{
					_tag: "human",
					issuer: "dev",
					subject: "operator",
					roles: ["producer"],
				},
				{ _tag: "machine", id, roles: ["viewer"] },
			],
		});
	});

	test("merge adds roles to the named identities and leaves others alone", async () => {
		const handler = webHandler([], admin);
		await handler(grantRequest("operator", "producer"));
		await handler(grantRequest("other", "judge"));
		const res = await handler(
			importRequest("merge", [
				{
					_tag: "human",
					issuer: "dev",
					subject: "operator",
					roles: ["viewer"],
				},
			]),
		);
		expect(res.status).toBe(204);
		const doc = Schema.decodeUnknownSync(
			Schema.Struct({
				assignments: Schema.Array(
					Schema.Struct({
						issuer: Schema.String,
						subject: Schema.String,
						roles: Schema.Array(Schema.String),
					}),
				),
			}),
		)(await (await handler(exportRequest())).json());
		expect(doc.assignments).toHaveLength(2);
		const operator = doc.assignments.find((a) => a.subject === "operator");
		const other = doc.assignments.find((a) => a.subject === "other");
		expect(operator?.roles).toHaveLength(2);
		expect(operator?.roles).toEqual(
			expect.arrayContaining(["producer", "viewer"]),
		);
		expect(other?.roles).toEqual(["judge"]);
	});

	test("replace overwrites the whole store", async () => {
		const handler = webHandler([], admin);
		await handler(grantRequest("operator", "producer"));
		await handler(grantRequest("other", "judge"));
		const res = await handler(
			importRequest("replace", [
				{
					_tag: "human",
					issuer: "dev",
					subject: "operator",
					roles: ["viewer"],
				},
			]),
		);
		expect(res.status).toBe(204);
		expect(await (await handler(exportRequest())).json()).toEqual({
			version: 0,
			assignments: [
				{
					_tag: "human",
					issuer: "dev",
					subject: "operator",
					roles: ["viewer"],
				},
			],
		});
	});

	test("replace clears roles of machines absent from the document", async () => {
		const handler = webHandler([], admin);
		const { id } = decodeId(
			await (await handler(createMachineRequest("scoreboard"))).json(),
		);
		await handler(machineRoleRequest(id, "viewer"));
		expect((await handler(importRequest("replace", []))).status).toBe(204);
		expect(await (await handler(listMachinesRequest())).json()).toEqual({
			machines: [{ id, displayName: "scoreboard", roles: [] }],
		});
	});

	test("excludes the admin tier from the export", async () => {
		const handler = webHandler([], tiered, withClaimToken);
		expect((await handler(withSid(claimRequest(), "founder"))).status).toBe(
			200,
		);
		await handler(withSid(grantRequest("founder", "producer"), "boss"));
		expect(
			await (await handler(withSid(exportRequest(), "boss"))).json(),
		).toEqual({
			version: 0,
			assignments: [
				{
					_tag: "human",
					issuer: "dev",
					subject: "founder",
					roles: ["producer"],
				},
			],
		});
	});

	test("merge keeps an admin tier the document does not mention", async () => {
		const handler = webHandler([], tiered, withClaimToken);
		await handler(withSid(claimRequest(), "founder"));
		expect(
			(
				await handler(
					withSid(
						importRequest("merge", [
							{
								_tag: "human",
								issuer: "dev",
								subject: "founder",
								roles: ["viewer"],
							},
						]),
						"boss",
					),
				)
			).status,
		).toBe(204);
		const { roles } = decodeRoles(
			await (
				await handler(withSid(grantRequest("founder", "judge"), "boss"))
			).json(),
		);
		expect(roles).toHaveLength(3);
		expect(roles).toEqual(
			expect.arrayContaining(["superadmin", "viewer", "judge"]),
		);
	});

	test("replace keeps the admin tier of an identity absent from the document", async () => {
		const handler = webHandler([], tiered, withClaimToken);
		await handler(withSid(claimRequest(), "founder"));
		await handler(withSid(grantRequest("founder", "producer"), "boss"));
		expect(
			(await handler(withSid(importRequest("replace", []), "boss"))).status,
		).toBe(204);
		const { roles } = decodeRoles(
			await (
				await handler(withSid(grantRequest("founder", "judge"), "boss"))
			).json(),
		);
		expect(roles).toEqual(["superadmin", "judge"]);
	});

	test("400 with a detail message for an admin-tier role on a human entry", async () => {
		const handler = webHandler([], admin);
		const res = await handler(
			importRequest("merge", [
				{
					_tag: "human",
					issuer: "dev",
					subject: "operator",
					roles: ["admin"],
				},
			]),
		);
		expect(res.status).toBe(400);
		expect(decodeImportError(await res.json()).message).toContain(
			"cannot be assigned via import",
		);
	});

	test("400 for a principal role on a human entry", async () => {
		const handler = webHandler([], admin);
		expect(
			(
				await handler(
					importRequest("merge", [
						{
							_tag: "human",
							issuer: "dev",
							subject: "operator",
							roles: ["server"],
						},
					]),
				)
			).status,
		).toBe(400);
	});

	test("400 for a reserved role on a machine entry", async () => {
		const handler = webHandler([], admin);
		expect(
			(
				await handler(
					importRequest("merge", [
						{ _tag: "machine", id: "anything", roles: ["admin"] },
					]),
				)
			).status,
		).toBe(400);
	});

	test("400 with a detail message for an unknown machine id", async () => {
		const handler = webHandler([], admin);
		const res = await handler(
			importRequest("merge", [
				{ _tag: "machine", id: "ghost", roles: ["viewer"] },
			]),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			_tag: "RoleImportError",
			message: 'unknown machine id "ghost"',
		});
	});

	test("400 for duplicate entries for one identity", async () => {
		const handler = webHandler([], admin);
		expect(
			(
				await handler(
					importRequest("merge", [
						{
							_tag: "human",
							issuer: "dev",
							subject: "operator",
							roles: ["viewer"],
						},
						{
							_tag: "human",
							issuer: "dev",
							subject: "operator",
							roles: ["judge"],
						},
					]),
				)
			).status,
		).toBe(400);
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
			roles: new Set([ADMIN_ROLE.admin]),
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

	const decodeCreated = Schema.decodeUnknownSync(
		Schema.Struct({ id: Schema.String }),
	);

	const listRequest = () =>
		new Request("http://x/api/internal/machines", { method: "GET" });

	const revokeRequest = (id: string) =>
		new Request(`http://x/api/internal/machines/${id}`, { method: "DELETE" });

	test("403 for an anonymous caller listing keys", async () => {
		const handler = webHandler([]);
		expect((await handler(listRequest())).status).toBe(403);
	});

	test("lists created keys without their token for an admin", async () => {
		const handler = webHandler([], admin);
		const { id } = decodeCreated(await (await handler(createRequest())).json());
		const res = await handler(listRequest());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			machines: [{ id, displayName: "scoreboard", roles: [] }],
		});
	});

	test("403 for an anonymous caller revoking a key", async () => {
		const handler = webHandler([]);
		expect((await handler(revokeRequest("anything"))).status).toBe(403);
	});

	test("revokes a key and drops it from the listing for an admin", async () => {
		const handler = webHandler([], admin);
		const { id } = decodeCreated(await (await handler(createRequest())).json());
		expect((await handler(revokeRequest(id))).status).toBe(204);
		expect(await (await handler(listRequest())).json()).toEqual({
			machines: [],
		});
	});

	test("404 when revoking an unknown id for an admin", async () => {
		const handler = webHandler([], admin);
		expect((await handler(revokeRequest("ghost"))).status).toBe(404);
	});

	const refreshRequest = (id: string) =>
		new Request(`http://x/api/internal/machines/${id}/refresh`, {
			method: "POST",
		});

	test("403 for an anonymous caller refreshing a key", async () => {
		const handler = webHandler([]);
		expect((await handler(refreshRequest("anything"))).status).toBe(403);
	});

	test("refreshes a key, keeping id and display name, for an admin", async () => {
		const handler = webHandler([], admin);
		const created = decodeCreated(
			await (await handler(createRequest())).json(),
		);
		const res = await handler(refreshRequest(created.id));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			id: created.id,
			displayName: "scoreboard",
			token: expect.stringMatching(/^ncg_/),
		});
	});

	test("404 when refreshing an unknown id for an admin", async () => {
		const handler = webHandler([], admin);
		expect((await handler(refreshRequest("ghost"))).status).toBe(404);
	});

	const grantRoleRequest = (id: string, role: string) =>
		new Request(`http://x/api/internal/machines/${id}/roles`, {
			method: "POST",
			body: JSON.stringify({ role }),
			headers: { "content-type": "application/json" },
		});

	const revokeRoleRequest = (id: string, role: string) =>
		new Request(`http://x/api/internal/machines/${id}/roles/${role}`, {
			method: "DELETE",
		});

	test("403 for an anonymous caller granting a role", async () => {
		const handler = webHandler([]);
		expect((await handler(grantRoleRequest("anything", "viewer"))).status).toBe(
			403,
		);
	});

	test("grants a named role and returns the updated set for an admin", async () => {
		const handler = webHandler([], admin);
		const { id } = decodeCreated(await (await handler(createRequest())).json());
		const res = await handler(grantRoleRequest(id, "viewer"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ roles: ["viewer"] });
	});

	test("403 when granting a reserved role to a machine", async () => {
		const handler = webHandler([], admin);
		const { id } = decodeCreated(await (await handler(createRequest())).json());
		expect((await handler(grantRoleRequest(id, "admin"))).status).toBe(403);
	});

	test("404 when granting to an unknown id for an admin", async () => {
		const handler = webHandler([], admin);
		expect((await handler(grantRoleRequest("ghost", "viewer"))).status).toBe(
			404,
		);
	});

	test("revokes a named role and returns the remaining set for an admin", async () => {
		const handler = webHandler([], admin);
		const { id } = decodeCreated(await (await handler(createRequest())).json());
		await handler(grantRoleRequest(id, "viewer"));
		await handler(grantRoleRequest(id, "judge"));
		const res = await handler(revokeRoleRequest(id, "viewer"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ roles: ["judge"] });
	});

	test("404 when revoking a role from an unknown id for an admin", async () => {
		const handler = webHandler([], admin);
		expect((await handler(revokeRoleRequest("ghost", "viewer"))).status).toBe(
			404,
		);
	});
});

describe("get", () => {
	test("returns the stored value", async () => {
		const handler = webHandler([
			registeredNamespace("root", {
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

	test("404 when a replicant read reports not-found", async () => {
		const handler = webHandler([
			registeredNamespace("root", {
				count: stubField({
					getEncoded: () =>
						Effect.fail(
							new ReplicantNotFound2({ namespace: "root", name: "count" }),
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
			registeredNamespace(
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
			registeredNamespace("root", {
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
			registeredNamespace("root", {
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

	test("404 when a replicant write reports not-found", async () => {
		const handler = webHandler([
			registeredNamespace("root", {
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
			registeredNamespace("root", {
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
			registeredNamespace("root", {
				count: stubField({ getEncoded: () => Effect.succeed(0), setEncoded }),
			}),
		]);
		const res = await handler(putRequest(7));
		expect(res.status).toBe(403);
	});

	test("403 when computed getEncoded denies the caller", async () => {
		const handler = webHandler([
			registeredNamespace("root", {}, { count: stubComputed(readDenied) }),
		]);
		const res = await handler(new Request(computedUrl));
		expect(res.status).toBe(403);
	});

	test("runs the encoded op with the resolved identity in context", async () => {
		const getEncoded = () =>
			CurrentIdentity.pipe(Effect.map((identity) => identity._tag));
		const handler = webHandler([
			registeredNamespace("root", {
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
			registeredNamespace("root", {}, {}, { chat: stubTopic(publishEncoded) }),
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
			registeredNamespace(
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
			registeredNamespace(
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
			registeredNamespace(
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
			registeredNamespace(
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
			registeredNamespace(
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
			registeredNamespace(
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

describe("public surface (v0) with bearer token", () => {
	const countNamespace = () =>
		registeredNamespace("root", {
			count: stubField({
				getEncoded: () => Effect.succeed(42),
				setEncoded: () => Effect.void,
			}),
		});

	const publicGetUrl = "http://x/api/v0/namespaces/root/replicant/count";

	const admin = asIdentity(
		HumanIdentitySchema.make({
			account: { issuer: "dev", subject: "boss", displayName: "Boss" },
			roles: new Set([ADMIN_ROLE.admin]),
		}),
	);

	const mintKey = async (handler: (req: Request) => Promise<Response>) => {
		const res = await handler(
			new Request("http://x/api/internal/machines", {
				method: "POST",
				body: JSON.stringify({ displayName: "scoreboard" }),
				headers: { "content-type": "application/json" },
			}),
		);
		const { token } = Schema.decodeUnknownSync(
			Schema.Struct({ token: Schema.String }),
		)(await res.json());
		return token;
	};

	test("401 for a resource request without a bearer", async () => {
		const handler = webHandler([countNamespace()]);
		expect((await handler(new Request(publicGetUrl))).status).toBe(401);
	});

	test("401 for a resource request with an unknown bearer", async () => {
		const handler = webHandler([countNamespace()]);
		const res = await handler(
			new Request(publicGetUrl, {
				headers: { authorization: "Bearer anything" },
			}),
		);
		expect(res.status).toBe(401);
	});

	test("authenticates a request bearing a provisioned api key", async () => {
		const handler = webHandler([countNamespace()], admin);
		const token = await mintKey(handler);
		const res = await handler(
			new Request(publicGetUrl, {
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toBe(42);
	});
});
