import { it } from "@effect/vitest";
import { type ResolvedPermission, FieldDecodeError } from "@nodecg-next/core";
import {
	HumanAuthenticationMiddleware,
	AnonymousIdentitySchema,
	CurrentIdentity,
	HumanIdentitySchema,
	type Identity,
	RoleName,
} from "@nodecg-next/internal";
import {
	computeTestHash,
	PatchNotApplicable,
	RevisionConflict,
} from "@nodecg-next/internal/occ";
import {
	ConfigProvider,
	Effect,
	HashMap,
	Layer,
	Redacted,
	Schema,
	Stream,
} from "effect";
import {
	FetchHttpClient,
	HttpEffect,
	HttpRouter,
	HttpServer,
} from "effect/unstable/http";
import { describe, expect, vi } from "vitest";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "../auth/auth-provider.ts";
import {
	AdminTierMiddlewareLive,
	HumanAuthenticationMiddlewareLive,
	MachineAuthenticationMiddlewareLive,
	SuperadminMiddlewareLive,
} from "../auth/middleware.ts";
import { type BuiltNamespace } from "../build-fields.ts";
import {
	DerivationEngineService,
	UnknownReplicant,
} from "../derivation-graph.ts";
import { RpcHandlerError } from "../field-builders/build-rpc.ts";
import { fieldInternal } from "../field-builders/field-internal-key.ts";
import { FieldPermissionDenied } from "../field-builders/permission.ts";
import {
	FieldRegistryService,
	type RegisteredNamespace,
} from "../field-registry.ts";
import { InMemoryMachineClientStore } from "../services/machine-client-store/in-memory-machine-client-store.ts";
import { InMemoryReplicantStorage } from "../services/replicant-storage/in-memory-replicant-storage.ts";
import { InMemoryRoleStore } from "../services/role-store/in-memory-role-store.ts";
import { InMemorySessionStore } from "../services/session-store/in-memory-session-store.ts";
import { InMemoryStashStore } from "../services/stash-store/in-memory-stash-store.ts";
import { InMemoryTopicBroker } from "../services/topic-broker/in-memory-topic-broker.ts";
import { RootApiLive } from "./http-api/build-root-api.ts";
import { UrlPath } from "./url-path.ts";

type ReplicantStub = BuiltNamespace["replicant"][string];
type Internal = ReplicantStub[typeof fieldInternal];

const openPermission: ResolvedPermission = {
	read: { roles: new Set(), rolesDenied: new Set() },
	write: { roles: new Set(), rolesDenied: new Set() },
	canRead: () => true,
	canWrite: () => true,
};

function stubField(
	internal: Pick<Internal, "getRevisioned" | "commitPatch">,
): ReplicantStub {
	const unused = vi.fn();
	const subscribeRevisioned = () => Effect.succeed(Stream.empty);
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
			getRevisioned: internal.getRevisioned,
			commitPatch: internal.commitPatch,
			subscribeRevisioned,
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
	declaredRoles: ReadonlySet<RoleName> = new Set(),
): RegisteredNamespace {
	return {
		namespace,
		declaredRoles,
		fields: { replicant, computed, topic, rpc },
	};
}

const asIdentity = (identity: Identity) =>
	Layer.succeed(HumanAuthenticationMiddleware, {
		cookie: (httpEffect) =>
			Effect.provideService(httpEffect, CurrentIdentity, identity),
	});

const webHandler = Effect.fn(function* (
	namespaces: ReadonlyArray<RegisteredNamespace>,
	middleware: typeof HumanAuthenticationMiddlewareLive = HumanAuthenticationMiddlewareLive,
	environment: Layer.Layer<never> = Layer.empty,
	options?: {
		providers?: HashMap.HashMap<string, AuthProvider>;
	},
) {
	const handler = yield* HttpRouter.toHttpEffect(
		RootApiLive.pipe(
			HttpRouter.provideRequest(
				Layer.mergeAll(
					FieldRegistryService.layer(namespaces),
					InMemoryTopicBroker,
					UrlPath.layer,
					FetchHttpClient.layer,
				),
			),
			Layer.provide(middleware),
			Layer.provide(MachineAuthenticationMiddlewareLive),
			Layer.provide(AdminTierMiddlewareLive),
			Layer.provide(SuperadminMiddlewareLive),
			Layer.provide(InMemorySessionStore),
			Layer.provide(InMemoryStashStore),
			Layer.provide(InMemoryRoleStore),
			Layer.provide(InMemoryMachineClientStore),
			Layer.provide(InMemoryReplicantStorage),
			Layer.provide(
				DerivationEngineService.layer.pipe(
					Layer.provide(InMemoryReplicantStorage),
				),
			),
			Layer.provide(
				Layer.succeed(
					AuthProviderRegistry,
					options?.providers ?? HashMap.empty<string, AuthProvider>(),
				),
			),
			Layer.provide(environment),
			Layer.provide(HttpServer.layerServices),
		),
	);
	const web = HttpEffect.toWebHandler(handler);
	return (request: Request) => Effect.promise(() => web(request));
});

const json = (res: Response) => Effect.promise(() => res.json());

const getUrl = "http://x/api/internal/namespaces/root/replicant/count";
const computedUrl = "http://x/api/internal/namespaces/root/computed/count";
const topicUrl = "http://x/api/internal/namespaces/root/topic/chat";
const rpcUrl = "http://x/api/internal/namespaces/root/rpc/echo";

const committed = () => Effect.succeed({ value: null, revision: 1 });

const putPatch = (patch: unknown) =>
	new Request(getUrl, {
		method: "PUT",
		body: JSON.stringify(patch),
		headers: { "content-type": "application/json" },
	});

const postRequest = (url: string, value: unknown) =>
	new Request(url, {
		method: "POST",
		body: JSON.stringify(value),
		headers: { "content-type": "application/json" },
	});

describe("me", () => {
	it.effect("resolves an anonymous request to the anonymous identity", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			const res = yield* handler(new Request("http://x/api/internal/me"));
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({
				identity: { _tag: "anonymous" },
				namespaces: {},
			});
		}),
	);

	it.effect("reports the held declared roles per namespace", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler(
				[
					registeredNamespace(
						"perms",
						{},
						{},
						{},
						{},
						new Set([RoleName("producer"), RoleName("viewer")]),
					),
				],
				asIdentity(
					HumanIdentitySchema.make({
						account: { issuer: "dev", subject: "op", displayName: "Op" },
						roles: new Set([RoleName("producer")]),
						globalRoles: new Set(),
					}),
				),
			);
			const res = yield* handler(new Request("http://x/api/internal/me"));
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({
				identity: {
					_tag: "human",
					account: { issuer: "dev", subject: "op", displayName: "Op" },
					roles: ["producer"],
					globalRoles: [],
				},
				namespaces: {
					perms: { roles: ["producer"] },
				},
			});
		}),
	);
});

describe("login and callback", () => {
	const devProvider: AuthProvider = {
		name: "dev",
		issuer: "dev",
		authorize: () =>
			Effect.succeed({
				url: "/api/internal/authentication/callback/dev?state=s",
				stash: { provider: "dev", state: "s" },
			}),
		callback: () =>
			Effect.succeed({ issuer: "dev", subject: "alice", displayName: "Alice" }),
	};
	const providers = HashMap.make(["dev", devProvider] as const);

	const loginHandler = () =>
		webHandler([], undefined, Layer.empty, { providers });

	const stashCookieOf = (res: Response) => {
		const match = (res.headers.get("set-cookie") ?? "").match(
			/nodecg\.login=([^;]+)/,
		);
		if (match === null) {
			throw new Error("login did not set the stash cookie");
		}
		return match[1];
	};

	const subPathEnv = ConfigProvider.layer(
		ConfigProvider.fromEnvRecord({
			NODECG_BASE_URL: "http://x/s/nodecg",
		}).pipe(ConfigProvider.orElse(ConfigProvider.fromEnv())),
	);

	it.effect("providers lists each registered provider with its login URL", () =>
		Effect.gen(function* () {
			const handler = yield* loginHandler();
			const res = yield* handler(
				new Request("http://x/api/internal/authentication/providers"),
			);
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual([
				{ name: "dev", url: "/api/internal/authentication/login/dev" },
			]);
		}),
	);

	it.effect("a callback with a stashed returnTo redirects there", () =>
		Effect.gen(function* () {
			const handler = yield* loginHandler();
			const login = yield* handler(
				new Request(
					"http://x/api/internal/authentication/login/dev?returnTo=%2Fdashboard",
				),
			);
			expect(login.status).toBe(302);
			const callback = yield* handler(
				new Request(
					"http://x/api/internal/authentication/callback/dev?state=s",
					{
						headers: { cookie: `nodecg.login=${stashCookieOf(login)}` },
					},
				),
			);
			expect(callback.status).toBe(302);
			expect(callback.headers.get("location")).toBe("/dashboard");
			expect(callback.headers.get("set-cookie")).toContain("nodecg.sid=");
		}),
	);

	it.effect(
		"a callback without a returnTo still renders the success page",
		() =>
			Effect.gen(function* () {
				const handler = yield* loginHandler();
				const login = yield* handler(
					new Request("http://x/api/internal/authentication/login/dev"),
				);
				expect(login.status).toBe(302);
				const callback = yield* handler(
					new Request(
						"http://x/api/internal/authentication/callback/dev?state=s",
						{
							headers: { cookie: `nodecg.login=${stashCookieOf(login)}` },
						},
					),
				);
				expect(callback.status).toBe(200);
				expect(yield* Effect.promise(() => callback.text())).toBe("Success");
			}),
	);

	it.effect("400 at request decode for a non-relative returnTo", () =>
		Effect.gen(function* () {
			const handler = yield* loginHandler();
			for (const returnTo of [
				"https://evil.example",
				"//evil.example",
				"/\\evil.example",
			]) {
				const res = yield* handler(
					new Request(
						`http://x/api/internal/authentication/login/dev?returnTo=${encodeURIComponent(returnTo)}`,
					),
				);
				expect(res.status).toBe(400);
			}
		}),
	);

	it.effect("providers prefixes each login URL with the base path", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], undefined, subPathEnv, {
				providers,
			});
			const res = yield* handler(
				new Request("http://x/api/internal/authentication/providers"),
			);
			expect(yield* json(res)).toEqual([
				{ name: "dev", url: "/s/nodecg/api/internal/authentication/login/dev" },
			]);
		}),
	);

	it.effect("login builds the callback redirect_uri under the base path", () =>
		Effect.gen(function* () {
			let captured: string | undefined;
			const capturing: AuthProvider = {
				name: "dev",
				issuer: "dev",
				authorize: ({ redirectUri }) => {
					captured = redirectUri;
					return Effect.succeed({
						url: "/done",
						stash: { provider: "dev", state: "s" },
					});
				},
				callback: () =>
					Effect.succeed({ issuer: "dev", subject: "a", displayName: "A" }),
			};
			const handler = yield* webHandler([], undefined, subPathEnv, {
				providers: HashMap.make(["dev", capturing] as const),
			});
			const res = yield* handler(
				new Request("http://x/api/internal/authentication/login/dev"),
			);
			expect(res.status).toBe(302);
			expect(captured).toBe(
				"http://x/s/nodecg/api/internal/authentication/callback/dev",
			);
		}),
	);
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
			roles: new Set(),
			globalRoles: new Set(["admin"]),
		}),
	);

	it.effect("403 for an anonymous caller", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			expect((yield* handler(rolesRequest("grant", "superadmin"))).status).toBe(
				403,
			);
			expect(
				(yield* handler(rolesRequest("revoke", "superadmin"))).status,
			).toBe(403);
		}),
	);

	it.effect("403 for a named-role caller without the admin tier", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler(
				[],
				asIdentity(
					HumanIdentitySchema.make({
						account: { issuer: "dev", subject: "op", displayName: "Op" },
						roles: new Set([RoleName("producer")]),
						globalRoles: new Set(),
					}),
				),
			);
			expect((yield* handler(rolesRequest("grant", "superadmin"))).status).toBe(
				403,
			);
		}),
	);

	it.effect(
		"grant returns the updated set, revoke removes it for an admin",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([], admin);
				const grant = yield* handler(rolesRequest("grant", "producer"));
				expect(grant.status).toBe(200);
				expect(yield* json(grant)).toEqual({ roles: ["producer"] });

				const revoke = yield* handler(rolesRequest("revoke", "producer"));
				expect(revoke.status).toBe(200);
				expect(yield* json(revoke)).toEqual({ roles: [] });
			}),
	);

	it.effect("403 when an admin grants an undeclarable role", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			expect((yield* handler(rolesRequest("grant", "superadmin"))).status).toBe(
				403,
			);
			expect((yield* handler(rolesRequest("grant", "admin"))).status).toBe(403);
			expect((yield* handler(rolesRequest("grant", "server"))).status).toBe(
				403,
			);
		}),
	);
});

describe("admin roles", () => {
	const adminRoleRequest = (
		action: "grant" | "revoke",
		subject: unknown,
		role: string,
	) =>
		postRequest(`http://x/api/internal/admin-roles/${action}`, {
			subject,
			role,
		});

	const human = { _tag: "human", issuer: "dev", subject: "operator" };

	const superadmin = asIdentity(
		HumanIdentitySchema.make({
			account: { issuer: "dev", subject: "root", displayName: "Root" },
			roles: new Set(),
			globalRoles: new Set(["superadmin"]),
		}),
	);

	const admin = asIdentity(
		HumanIdentitySchema.make({
			account: { issuer: "dev", subject: "boss", displayName: "Boss" },
			roles: new Set(),
			globalRoles: new Set(["admin"]),
		}),
	);

	const decodeId = Schema.decodeUnknownSync(
		Schema.Struct({ id: Schema.String }),
	);

	const createMachine = Effect.fn(function* (
		handler: (request: Request) => Effect.Effect<Response>,
	) {
		const res = yield* handler(
			postRequest("http://x/api/internal/machines", { displayName: "bot" }),
		);
		return decodeId(yield* json(res));
	});

	it.effect("403 for an anonymous caller", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			expect(
				(yield* handler(adminRoleRequest("grant", human, "admin"))).status,
			).toBe(403);
			expect(
				(yield* handler(adminRoleRequest("revoke", human, "admin"))).status,
			).toBe(403);
		}),
	);

	it.effect("403 for an admin-tier caller who is not a superadmin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			expect(
				(yield* handler(adminRoleRequest("grant", human, "admin"))).status,
			).toBe(403);
		}),
	);

	it.effect("superadmin grants and revokes the admin tier for a human", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], superadmin);
			const grant = yield* handler(adminRoleRequest("grant", human, "admin"));
			expect(grant.status).toBe(200);
			expect(yield* json(grant)).toEqual({ roles: ["admin"] });

			const revoke = yield* handler(adminRoleRequest("revoke", human, "admin"));
			expect(revoke.status).toBe(200);
			expect(yield* json(revoke)).toEqual({ roles: [] });
		}),
	);

	it.effect("superadmin grants superadmin to a human", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], superadmin);
			const res = yield* handler(
				adminRoleRequest("grant", human, "superadmin"),
			);
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({ roles: ["superadmin"] });
		}),
	);

	it.effect("400 for a payload role outside the admin tier", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], superadmin);
			expect(
				(yield* handler(adminRoleRequest("grant", human, "producer"))).status,
			).toBe(400);
		}),
	);

	it.effect("superadmin grants the admin tier to a machine", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], superadmin);
			const { id } = yield* createMachine(handler);
			const res = yield* handler(
				adminRoleRequest("grant", { _tag: "machine", id }, "admin"),
			);
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({ roles: ["admin"] });
		}),
	);

	it.effect("404 when granting the admin tier to an unknown machine", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], superadmin);
			expect(
				(yield* handler(
					adminRoleRequest("grant", { _tag: "machine", id: "ghost" }, "admin"),
				)).status,
			).toBe(404);
		}),
	);
});

describe("claim superadmin", () => {
	const claimUrl = "http://x/api/internal/authentication/claim-superadmin";
	const claimRequest = (token: string) => postRequest(claimUrl, { token });

	const human = asIdentity(
		HumanIdentitySchema.make({
			account: { issuer: "dev", subject: "founder", displayName: "Founder" },
			roles: new Set(),
			globalRoles: new Set(),
		}),
	);

	const withClaimToken = ConfigProvider.layer(
		ConfigProvider.fromEnvRecord({
			SUPERADMIN_CLAIM_TOKEN: "super-secret-claim-token",
		}),
	);

	it.effect(
		"grants superadmin to the logged-in human presenting the token",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([], human, withClaimToken);
				const res = yield* handler(claimRequest("super-secret-claim-token"));
				expect(res.status).toBe(200);
				expect(yield* json(res)).toEqual({ roles: ["superadmin"] });
			}),
	);

	it.effect("403 for a wrong token, without closing the window", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], human, withClaimToken);
			expect(
				(yield* handler(claimRequest("wrong-token-of-real-length"))).status,
			).toBe(403);
			expect(
				(yield* handler(claimRequest("super-secret-claim-token"))).status,
			).toBe(200);
		}),
	);

	it.effect("403 for an anonymous caller", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], undefined, withClaimToken);
			expect(
				(yield* handler(claimRequest("super-secret-claim-token"))).status,
			).toBe(403);
		}),
	);

	it.effect("403 when no claim token is configured", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], human);
			expect(
				(yield* handler(claimRequest("super-secret-claim-token"))).status,
			).toBe(403);
		}),
	);

	it.effect("the first successful claim closes the window", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], human, withClaimToken);
			expect(
				(yield* handler(claimRequest("super-secret-claim-token"))).status,
			).toBe(200);
			expect(
				(yield* handler(claimRequest("super-secret-claim-token"))).status,
			).toBe(403);
		}),
	);

	it.effect("429 after too many attempts in the window", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], human, withClaimToken);
			for (let attempt = 0; attempt < 5; attempt++) {
				expect(
					(yield* handler(claimRequest("wrong-token-of-real-length"))).status,
				).toBe(403);
			}
			expect(
				(yield* handler(claimRequest("super-secret-claim-token"))).status,
			).toBe(429);
		}),
	);

	it.effect("an anonymous flood does not consume the claim budget", () =>
		Effect.gen(function* () {
			const bySid = Layer.succeed(HumanAuthenticationMiddleware, {
				cookie: (httpEffect, { credential }) =>
					Effect.provideService(
						httpEffect,
						CurrentIdentity,
						Redacted.value(credential) === "founder"
							? HumanIdentitySchema.make({
									account: {
										issuer: "dev",
										subject: "founder",
										displayName: "Founder",
									},
									roles: new Set(),
									globalRoles: new Set(),
								})
							: AnonymousIdentitySchema.make({}),
					),
			});
			const handler = yield* webHandler([], bySid, withClaimToken);
			const withSid = (request: Request, sid: string) => {
				request.headers.set("cookie", `nodecg.sid=${sid}`);
				return request;
			};
			for (let attempt = 0; attempt < 10; attempt++) {
				expect(
					(yield* handler(claimRequest("super-secret-claim-token"))).status,
				).toBe(403);
			}
			expect(
				(yield* handler(
					withSid(claimRequest("super-secret-claim-token"), "founder"),
				)).status,
			).toBe(200);
		}),
	);
});

describe("roles export/import", () => {
	const founderIdentity = HumanIdentitySchema.make({
		account: { issuer: "dev", subject: "founder", displayName: "Founder" },
		roles: new Set(),
		globalRoles: new Set(),
	});
	const adminIdentity = HumanIdentitySchema.make({
		account: { issuer: "dev", subject: "boss", displayName: "Boss" },
		roles: new Set(),
		globalRoles: new Set(["admin"]),
	});
	const admin = asIdentity(adminIdentity);

	const identityBySubject = (identities: Record<string, Identity>) =>
		Layer.succeed(HumanAuthenticationMiddleware, {
			cookie: (httpEffect, { credential }) =>
				Effect.provideService(
					httpEffect,
					CurrentIdentity,
					identities[Redacted.value(credential)] ??
						AnonymousIdentitySchema.make({}),
				),
		});

	const tiered = identityBySubject({
		founder: founderIdentity,
		boss: adminIdentity,
		root: HumanIdentitySchema.make({
			account: { issuer: "dev", subject: "root", displayName: "Root" },
			roles: new Set(),
			globalRoles: new Set(["superadmin"]),
		}),
	});

	const grantFounderAdminRequest = () =>
		postRequest("http://x/api/internal/admin-roles/grant", {
			subject: { _tag: "human", issuer: "dev", subject: "founder" },
			role: "admin",
		});

	const withClaimToken = ConfigProvider.layer(
		ConfigProvider.fromEnvRecord({
			SUPERADMIN_CLAIM_TOKEN: "super-secret-claim-token",
		}),
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

	const decodeImportError = Schema.decodeUnknownSync(
		Schema.Struct({ message: Schema.String }),
	);

	const decodeAssignmentsDocument = Schema.decodeUnknownSync(
		Schema.Struct({
			assignments: Schema.Array(
				Schema.Struct({
					issuer: Schema.String,
					subject: Schema.String,
					roles: Schema.Array(Schema.String),
				}),
			),
		}),
	);

	it.effect("403 for an anonymous caller", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			expect((yield* handler(exportRequest())).status).toBe(403);
			expect((yield* handler(importRequest("merge", []))).status).toBe(403);
		}),
	);

	it.effect("403 for a named-role caller without the admin tier", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler(
				[],
				asIdentity(
					HumanIdentitySchema.make({
						account: { issuer: "dev", subject: "op", displayName: "Op" },
						roles: new Set([RoleName("producer")]),
						globalRoles: new Set(),
					}),
				),
			);
			expect((yield* handler(exportRequest())).status).toBe(403);
			expect((yield* handler(importRequest("merge", []))).status).toBe(403);
		}),
	);

	it.effect("exports human and machine assignments for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			yield* handler(grantRequest("operator", "producer"));
			const { id } = decodeId(
				yield* json(yield* handler(createMachineRequest("scoreboard"))),
			);
			yield* handler(machineRoleRequest(id, "viewer"));
			yield* handler(createMachineRequest("idle"));
			const res = yield* handler(exportRequest());
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({
				version: 0,
				assignments: [
					{
						_tag: "human",
						issuer: "dev",
						subject: "operator",
						roles: ["producer"],
						globalRoles: [],
					},
					{ _tag: "machine", id, roles: ["viewer"], globalRoles: [] },
				],
			});
		}),
	);

	it.effect(
		"merge adds roles to the named identities and leaves others alone",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([], admin);
				yield* handler(grantRequest("operator", "producer"));
				yield* handler(grantRequest("other", "judge"));
				const res = yield* handler(
					importRequest("merge", [
						{
							_tag: "human",
							issuer: "dev",
							subject: "operator",
							roles: ["viewer"],
							globalRoles: [],
						},
					]),
				);
				expect(res.status).toBe(204);
				const doc = decodeAssignmentsDocument(
					yield* json(yield* handler(exportRequest())),
				);
				expect(doc.assignments).toHaveLength(2);
				const operator = doc.assignments.find((a) => a.subject === "operator");
				const other = doc.assignments.find((a) => a.subject === "other");
				expect(operator?.roles).toHaveLength(2);
				expect(operator?.roles).toEqual(
					expect.arrayContaining(["producer", "viewer"]),
				);
				expect(other?.roles).toEqual(["judge"]);
			}),
	);

	it.effect("replace overwrites the whole store", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			yield* handler(grantRequest("operator", "producer"));
			yield* handler(grantRequest("other", "judge"));
			const res = yield* handler(
				importRequest("replace", [
					{
						_tag: "human",
						issuer: "dev",
						subject: "operator",
						roles: ["viewer"],
						globalRoles: [],
					},
				]),
			);
			expect(res.status).toBe(204);
			expect(yield* json(yield* handler(exportRequest()))).toEqual({
				version: 0,
				assignments: [
					{
						_tag: "human",
						issuer: "dev",
						subject: "operator",
						roles: ["viewer"],
						globalRoles: [],
					},
				],
			});
		}),
	);

	it.effect("replace clears roles of machines absent from the document", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			const { id } = decodeId(
				yield* json(yield* handler(createMachineRequest("scoreboard"))),
			);
			yield* handler(machineRoleRequest(id, "viewer"));
			expect((yield* handler(importRequest("replace", []))).status).toBe(204);
			expect(yield* json(yield* handler(listMachinesRequest()))).toEqual({
				machines: [
					{ id, displayName: "scoreboard", roles: [], globalRoles: [] },
				],
			});
		}),
	);

	it.effect("excludes the admin tier from the export", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], tiered, withClaimToken);
			expect((yield* handler(withSid(claimRequest(), "founder"))).status).toBe(
				200,
			);
			yield* handler(withSid(grantRequest("founder", "producer"), "boss"));
			expect(
				yield* json(yield* handler(withSid(exportRequest(), "boss"))),
			).toEqual({
				version: 0,
				assignments: [
					{
						_tag: "human",
						issuer: "dev",
						subject: "founder",
						roles: ["producer"],
						globalRoles: [],
					},
				],
			});
		}),
	);

	it.effect("merge keeps an admin tier the document does not mention", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], tiered, withClaimToken);
			yield* handler(withSid(claimRequest(), "founder"));
			expect(
				(yield* handler(
					withSid(
						importRequest("merge", [
							{
								_tag: "human",
								issuer: "dev",
								subject: "founder",
								roles: ["viewer"],
								globalRoles: [],
							},
						]),
						"boss",
					),
				)).status,
			).toBe(204);
			expect(
				yield* json(
					yield* handler(withSid(grantFounderAdminRequest(), "root")),
				),
			).toEqual({ roles: ["superadmin", "admin"] });
		}),
	);

	it.effect(
		"replace keeps the admin tier of an identity absent from the document",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([], tiered, withClaimToken);
				yield* handler(withSid(claimRequest(), "founder"));
				yield* handler(withSid(grantRequest("founder", "producer"), "boss"));
				expect(
					(yield* handler(withSid(importRequest("replace", []), "boss")))
						.status,
				).toBe(204);
				expect(
					yield* json(
						yield* handler(withSid(grantFounderAdminRequest(), "root")),
					),
				).toEqual({ roles: ["superadmin", "admin"] });
			}),
	);

	it.effect("400 with a detail message for an admin-tier global role", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			const res = yield* handler(
				importRequest("merge", [
					{
						_tag: "human",
						issuer: "dev",
						subject: "operator",
						roles: [],
						globalRoles: ["superadmin"],
					},
				]),
			);
			expect(res.status).toBe(400);
			expect(yield* json(res)).toEqual({
				_tag: "RoleImportError",
				message:
					'role "superadmin" cannot be assigned via import (entry {"_tag":"human","issuer":"dev","subject":"operator"})',
			});
		}),
	);

	it.effect(
		"400 with a detail message for an admin-tier role on a human entry",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([], admin);
				const res = yield* handler(
					importRequest("merge", [
						{
							_tag: "human",
							issuer: "dev",
							subject: "operator",
							roles: ["admin"],
							globalRoles: [],
						},
					]),
				);
				expect(res.status).toBe(400);
				expect(decodeImportError(yield* json(res)).message).toContain(
					"cannot be assigned via import",
				);
			}),
	);

	it.effect("400 for a principal role on a human entry", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			expect(
				(yield* handler(
					importRequest("merge", [
						{
							_tag: "human",
							issuer: "dev",
							subject: "operator",
							roles: ["server"],
							globalRoles: [],
						},
					]),
				)).status,
			).toBe(400);
		}),
	);

	it.effect("400 for a reserved role on a machine entry", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			expect(
				(yield* handler(
					importRequest("merge", [
						{
							_tag: "machine",
							id: "anything",
							roles: ["admin"],
							globalRoles: [],
						},
					]),
				)).status,
			).toBe(400);
		}),
	);

	it.effect("400 with a detail message for an unknown machine id", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			const res = yield* handler(
				importRequest("merge", [
					{ _tag: "machine", id: "ghost", roles: ["viewer"], globalRoles: [] },
				]),
			);
			expect(res.status).toBe(400);
			expect(yield* json(res)).toEqual({
				_tag: "RoleImportError",
				message: 'unknown machine id "ghost"',
			});
		}),
	);

	it.effect("400 for duplicate entries for one identity", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			expect(
				(yield* handler(
					importRequest("merge", [
						{
							_tag: "human",
							issuer: "dev",
							subject: "operator",
							roles: ["viewer"],
							globalRoles: [],
						},
						{
							_tag: "human",
							issuer: "dev",
							subject: "operator",
							roles: ["judge"],
							globalRoles: [],
						},
					]),
				)).status,
			).toBe(400);
		}),
	);
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
			roles: new Set(),
			globalRoles: new Set(["admin"]),
		}),
	);

	it.effect("403 for an anonymous caller", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			expect((yield* handler(createRequest())).status).toBe(403);
		}),
	);

	it.effect("mints an api key with an id and prefixed token for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			const res = yield* handler(createRequest());
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({
				id: expect.any(String),
				displayName: "scoreboard",
				token: expect.stringMatching(/^ncg_/),
			});
		}),
	);

	const decodeCreated = Schema.decodeUnknownSync(
		Schema.Struct({ id: Schema.String }),
	);

	const listRequest = () =>
		new Request("http://x/api/internal/machines", { method: "GET" });

	const revokeRequest = (id: string) =>
		new Request(`http://x/api/internal/machines/${id}`, { method: "DELETE" });

	it.effect("403 for an anonymous caller listing keys", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			expect((yield* handler(listRequest())).status).toBe(403);
		}),
	);

	it.effect("lists created keys without their token for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			const { id } = decodeCreated(
				yield* json(yield* handler(createRequest())),
			);
			const res = yield* handler(listRequest());
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({
				machines: [
					{ id, displayName: "scoreboard", roles: [], globalRoles: [] },
				],
			});
		}),
	);

	it.effect("403 for an anonymous caller revoking a key", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			expect((yield* handler(revokeRequest("anything"))).status).toBe(403);
		}),
	);

	it.effect("revokes a key and drops it from the listing for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			const { id } = decodeCreated(
				yield* json(yield* handler(createRequest())),
			);
			expect((yield* handler(revokeRequest(id))).status).toBe(204);
			expect(yield* json(yield* handler(listRequest()))).toEqual({
				machines: [],
			});
		}),
	);

	it.effect("404 when revoking an unknown id for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			expect((yield* handler(revokeRequest("ghost"))).status).toBe(404);
		}),
	);

	const refreshRequest = (id: string) =>
		new Request(`http://x/api/internal/machines/${id}/refresh`, {
			method: "POST",
		});

	it.effect("403 for an anonymous caller refreshing a key", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			expect((yield* handler(refreshRequest("anything"))).status).toBe(403);
		}),
	);

	it.effect("refreshes a key, keeping id and display name, for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			const created = decodeCreated(
				yield* json(yield* handler(createRequest())),
			);
			const res = yield* handler(refreshRequest(created.id));
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({
				id: created.id,
				displayName: "scoreboard",
				token: expect.stringMatching(/^ncg_/),
			});
		}),
	);

	it.effect("404 when refreshing an unknown id for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			expect((yield* handler(refreshRequest("ghost"))).status).toBe(404);
		}),
	);

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

	it.effect("403 for an anonymous caller granting a role", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			expect(
				(yield* handler(grantRoleRequest("anything", "viewer"))).status,
			).toBe(403);
		}),
	);

	it.effect(
		"grants a named role and returns the updated set for an admin",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([], admin);
				const { id } = decodeCreated(
					yield* json(yield* handler(createRequest())),
				);
				const res = yield* handler(grantRoleRequest(id, "viewer"));
				expect(res.status).toBe(200);
				expect(yield* json(res)).toEqual({ roles: ["viewer"] });
			}),
	);

	it.effect("403 when granting a reserved role to a machine", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			const { id } = decodeCreated(
				yield* json(yield* handler(createRequest())),
			);
			expect((yield* handler(grantRoleRequest(id, "admin"))).status).toBe(403);
		}),
	);

	it.effect("404 when granting to an unknown id for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			expect((yield* handler(grantRoleRequest("ghost", "viewer"))).status).toBe(
				404,
			);
		}),
	);

	it.effect(
		"revokes a named role and returns the remaining set for an admin",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([], admin);
				const { id } = decodeCreated(
					yield* json(yield* handler(createRequest())),
				);
				yield* handler(grantRoleRequest(id, "viewer"));
				yield* handler(grantRoleRequest(id, "judge"));
				const res = yield* handler(revokeRoleRequest(id, "viewer"));
				expect(res.status).toBe(200);
				expect(yield* json(res)).toEqual({ roles: ["judge"] });
			}),
	);

	it.effect("404 when revoking a role from an unknown id for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			expect(
				(yield* handler(revokeRoleRequest("ghost", "viewer"))).status,
			).toBe(404);
		}),
	);
});

describe("get", () => {
	it.effect("returns the stored value", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
				registeredNamespace("root", {
					count: stubField({
						getRevisioned: () => Effect.succeed({ value: 42, revision: 0 }),
						commitPatch: committed,
					}),
				}),
			]);
			const res = yield* handler(new Request(getUrl));
			expect(res.status).toBe(200);
			expect(yield* json(res)).toBe(42);
		}),
	);

	it.effect("404 when the namespace/name is not registered", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			const res = yield* handler(new Request(getUrl));
			expect(res.status).toBe(404);
		}),
	);

	it.effect("404 when a replicant read reports not-found", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
				registeredNamespace("root", {
					count: stubField({
						getRevisioned: () =>
							Effect.fail(
								new UnknownReplicant({ namespace: "root", name: "count" }),
							),
						commitPatch: committed,
					}),
				}),
			]);
			const res = yield* handler(new Request(getUrl));
			expect(res.status).toBe(404);
		}),
	);

	it.effect("returns a computed field's value", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
				registeredNamespace(
					"root",
					{},
					{ count: stubComputed(() => Effect.succeed(84)) },
				),
			]);
			const res = yield* handler(new Request(computedUrl));
			expect(res.status).toBe(200);
			expect(yield* json(res)).toBe(84);
		}),
	);
});

describe("update", () => {
	it.effect(
		"passes a root replace patch through to the field and returns 204",
		() =>
			Effect.gen(function* () {
				const commitPatch = vi.fn(committed);
				const handler = yield* webHandler([
					registeredNamespace("root", {
						count: stubField({
							getRevisioned: () => Effect.succeed({ value: 0, revision: 0 }),
							commitPatch,
						}),
					}),
				]);
				const res = yield* handler(
					putPatch([{ op: "replace", path: "", value: 7 }]),
				);
				expect(res.status).toBe(204);
				expect(commitPatch).toHaveBeenCalledWith([
					{ op: "replace", path: "", value: 7 },
				]);
			}),
	);

	it.effect("passes a field-level patch through whole", () =>
		Effect.gen(function* () {
			const commitPatch = vi.fn(committed);
			const handler = yield* webHandler([
				registeredNamespace("root", {
					count: stubField({
						getRevisioned: () => Effect.succeed({ value: 0, revision: 0 }),
						commitPatch,
					}),
				}),
			]);
			const res = yield* handler(
				putPatch([
					{ op: "replace", path: "/a", value: 7 },
					{ op: "replace", path: "/b/0", value: 8 },
				]),
			);
			expect(res.status).toBe(204);
			expect(commitPatch).toHaveBeenCalledWith([
				{ op: "replace", path: "/a", value: 7 },
				{ op: "replace", path: "/b/0", value: 8 },
			]);
		}),
	);

	it.effect("400 when the payload is not a patch", () =>
		Effect.gen(function* () {
			const commitPatch = vi.fn(committed);
			const handler = yield* webHandler([
				registeredNamespace("root", {
					count: stubField({
						getRevisioned: () => Effect.succeed({ value: 0, revision: 0 }),
						commitPatch,
					}),
				}),
			]);
			expect((yield* handler(putPatch(7))).status).toBe(400);
			expect((yield* handler(putPatch([]))).status).toBe(400);
			expect(
				(yield* handler(putPatch([{ op: "replace", path: "a", value: 7 }])))
					.status,
			).toBe(400);
			expect(commitPatch).not.toHaveBeenCalled();
		}),
	);

	it.effect("422 when the field reports PatchNotApplicable", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
				registeredNamespace("root", {
					count: stubField({
						getRevisioned: () => Effect.succeed({ value: 0, revision: 0 }),
						commitPatch: () =>
							Effect.fail(
								new PatchNotApplicable({ path: "/a", reason: "MissingKey" }),
							),
					}),
				}),
			]);
			const res = yield* handler(
				putPatch([{ op: "replace", path: "/a", value: 7 }]),
			);
			expect(res.status).toBe(422);
			expect(yield* json(res)).toEqual({
				_tag: "PatchNotApplicable",
				path: "/a",
				reason: "MissingKey",
			});
		}),
	);

	it.effect(
		"409 with the current value when the field reports RevisionConflict",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([
					registeredNamespace("root", {
						count: stubField({
							getRevisioned: () => Effect.succeed({ value: 0, revision: 0 }),
							commitPatch: () =>
								Effect.fail(
									new RevisionConflict({
										value: 9,
										revision: 3,
										reason: "HashMismatch",
									}),
								),
						}),
					}),
				]);
				const res = yield* handler(
					putPatch([
						{ op: "test-hash", path: "", hash: computeTestHash(0) },
						{ op: "replace", path: "", value: 7 },
					]),
				);
				expect(res.status).toBe(409);
				expect(yield* json(res)).toEqual({
					_tag: "RevisionConflict",
					value: 9,
					revision: 3,
					reason: "HashMismatch",
				});
			}),
	);

	it.effect("404 when the namespace/name is not registered", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			const res = yield* handler(
				putPatch([{ op: "replace", path: "", value: 7 }]),
			);
			expect(res.status).toBe(404);
		}),
	);

	it.effect("400 when the field reports FieldDecodeError", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
				registeredNamespace("root", {
					count: stubField({
						getRevisioned: () => Effect.succeed({ value: 0, revision: 0 }),
						commitPatch: () =>
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
			const res = yield* handler(
				putPatch([{ op: "replace", path: "", value: 7 }]),
			);
			expect(res.status).toBe(400);
		}),
	);

	it.effect("404 when a replicant write reports not-found", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
				registeredNamespace("root", {
					count: stubField({
						getRevisioned: () => Effect.succeed({ value: 0, revision: 0 }),
						commitPatch: () =>
							Effect.fail(
								new UnknownReplicant({ namespace: "root", name: "count" }),
							),
					}),
				}),
			]);
			const res = yield* handler(
				putPatch([{ op: "replace", path: "", value: 7 }]),
			);
			expect(res.status).toBe(404);
		}),
	);
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

	it.effect("403 when replicant getRevisioned denies the caller", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
				registeredNamespace("root", {
					count: stubField({
						getRevisioned: readDenied,
						commitPatch: committed,
					}),
				}),
			]);
			const res = yield* handler(new Request(getUrl));
			expect(res.status).toBe(403);
		}),
	);

	it.effect("403 when replicant commitPatch denies the caller", () =>
		Effect.gen(function* () {
			const commitPatch = vi.fn(writeDenied);
			const handler = yield* webHandler([
				registeredNamespace("root", {
					count: stubField({
						getRevisioned: () => Effect.succeed({ value: 0, revision: 0 }),
						commitPatch,
					}),
				}),
			]);
			const res = yield* handler(
				putPatch([{ op: "replace", path: "", value: 7 }]),
			);
			expect(res.status).toBe(403);
		}),
	);

	it.effect("403 when computed getEncoded denies the caller", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
				registeredNamespace("root", {}, { count: stubComputed(readDenied) }),
			]);
			const res = yield* handler(new Request(computedUrl));
			expect(res.status).toBe(403);
		}),
	);

	it.effect("runs the encoded op with the resolved identity in context", () =>
		Effect.gen(function* () {
			const getRevisioned = () =>
				CurrentIdentity.pipe(
					Effect.map((identity) => ({ value: identity._tag, revision: 0 })),
				);
			const handler = yield* webHandler([
				registeredNamespace("root", {
					count: stubField({ getRevisioned, commitPatch: committed }),
				}),
			]);
			const res = yield* handler(new Request(getUrl));
			expect(yield* json(res)).toBe("anonymous");
		}),
	);
});

describe("topic publish", () => {
	it.effect("forwards an allowed value and returns 204", () =>
		Effect.gen(function* () {
			const publishEncoded = vi.fn((_value: unknown) => Effect.void);
			const handler = yield* webHandler([
				registeredNamespace(
					"root",
					{},
					{},
					{ chat: stubTopic(publishEncoded) },
				),
			]);
			const res = yield* handler(postRequest(topicUrl, 5));
			expect(res.status).toBe(204);
			expect(publishEncoded).toHaveBeenCalledWith(5);
		}),
	);

	it.effect("404 when the namespace/name is not registered", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			expect((yield* handler(postRequest(topicUrl, 5))).status).toBe(404);
		}),
	);

	it.effect("403 when publishEncoded denies the caller", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
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
			expect((yield* handler(postRequest(topicUrl, 5))).status).toBe(403);
		}),
	);

	it.effect("400 when publishEncoded reports FieldDecodeError", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
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
			expect((yield* handler(postRequest(topicUrl, 5))).status).toBe(400);
		}),
	);
});

describe("rpc call", () => {
	it.effect("returns the encoded handler response", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
				registeredNamespace(
					"root",
					{},
					{},
					{},
					{ echo: stubRpc(() => Effect.succeed(84)) },
				),
			]);
			const res = yield* handler(postRequest(rpcUrl, 42));
			expect(res.status).toBe(200);
			expect(yield* json(res)).toBe(84);
		}),
	);

	it.effect("404 when the proc is not registered", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			expect((yield* handler(postRequest(rpcUrl, 42))).status).toBe(404);
		}),
	);

	it.effect("403 when callEncoded denies the caller", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
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
			expect((yield* handler(postRequest(rpcUrl, 42))).status).toBe(403);
		}),
	);

	it.effect("400 when callEncoded reports FieldDecodeError", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
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
			expect((yield* handler(postRequest(rpcUrl, 42))).status).toBe(400);
		}),
	);

	it.effect("500 when the handler fails", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([
				registeredNamespace(
					"root",
					{},
					{},
					{},
					{
						echo: stubRpc(() =>
							Effect.fail(
								new RpcHandlerError({
									namespace: "root",
									name: "echo",
									cause: new Error("boom"),
								}),
							),
						),
					},
				),
			]);
			expect((yield* handler(postRequest(rpcUrl, 42))).status).toBe(500);
		}),
	);
});

describe("public surface (v0) with bearer token", () => {
	const countNamespace = () =>
		registeredNamespace("root", {
			count: stubField({
				getRevisioned: () => Effect.succeed({ value: 42, revision: 0 }),
				commitPatch: committed,
			}),
		});

	const publicGetUrl = "http://x/api/v0/namespaces/root/replicant/count";

	const admin = asIdentity(
		HumanIdentitySchema.make({
			account: { issuer: "dev", subject: "boss", displayName: "Boss" },
			roles: new Set(),
			globalRoles: new Set(["admin"]),
		}),
	);

	const decodeToken = Schema.decodeUnknownSync(
		Schema.Struct({ token: Schema.String }),
	);

	const mintKey = Effect.fn(function* (
		handler: (request: Request) => Effect.Effect<Response>,
	) {
		const res = yield* handler(
			new Request("http://x/api/internal/machines", {
				method: "POST",
				body: JSON.stringify({ displayName: "scoreboard" }),
				headers: { "content-type": "application/json" },
			}),
		);
		const { token } = decodeToken(yield* json(res));
		return token;
	});

	it.effect("401 for a resource request without a bearer", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([countNamespace()]);
			expect((yield* handler(new Request(publicGetUrl))).status).toBe(401);
		}),
	);

	it.effect("401 for a resource request with an unknown bearer", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([countNamespace()]);
			const res = yield* handler(
				new Request(publicGetUrl, {
					headers: { authorization: "Bearer anything" },
				}),
			);
			expect(res.status).toBe(401);
		}),
	);

	it.effect("authenticates a request bearing a provisioned api key", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([countNamespace()], admin);
			const token = yield* mintKey(handler);
			const res = yield* handler(
				new Request(publicGetUrl, {
					headers: { authorization: `Bearer ${token}` },
				}),
			);
			expect(res.status).toBe(200);
			expect(yield* json(res)).toBe(42);
		}),
	);
});
