import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { type ResolvedPermission, FieldDecodeError } from "@nodecg-next/core";
import {
	UserAuthenticationMiddleware,
	AnonymousIdentitySchema,
	CurrentIdentity,
	User,
	type Identity,
	RoleName,
} from "@nodecg-next/internal";
import {
	computeTestHash,
	PatchNotApplicable,
	RevisionConflict,
} from "@nodecg-next/internal/occ";
import {
	Config,
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
import { Reactivity } from "effect/unstable/reactivity";
import { describe, expect, vi } from "vitest";

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
import { DrizzleSqliteDatabaseService } from "../services/database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { DrizzleSqliteAuthenticationRepository } from "../services/repository/authentication/drizzle-sqlite-authentication-repository.ts";
import { DrizzleSqliteLoginAttemptRepository } from "../services/repository/login-attempt/drizzle-sqlite-login-attempt-repository.ts";
import { InMemoryReplicantRepository } from "../services/repository/replicant/in-memory-replicant-repository.ts";
import { DrizzleSqliteSessionRepository } from "../services/repository/session/drizzle-sqlite-session-repository.ts";
import { InMemoryRoleStore } from "../services/role-store/in-memory-role-store.ts";
import { InMemoryServiceAccountStore } from "../services/service-account-store/in-memory-service-account-store.ts";
import { InMemoryTopicBroker } from "../services/topic-broker/in-memory-topic-broker.ts";
import { DrizzleSqliteTransaction } from "../services/transaction/drizzle-sqlite-transaction.ts";
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

const show = registeredNamespace(
	"show",
	{},
	{},
	{},
	{},
	new Set([RoleName("producer"), RoleName("viewer"), RoleName("judge")]),
);

const asIdentity = (identity: Identity) =>
	Layer.succeed(UserAuthenticationMiddleware, {
		cookie: (httpEffect) =>
			Effect.provideService(httpEffect, CurrentIdentity, identity),
	});

const webHandler = Effect.fn(function* (
	namespaces: ReadonlyArray<RegisteredNamespace>,
	middleware: typeof UserAuthenticationMiddlewareLive = UserAuthenticationMiddlewareLive,
	environment: Layer.Layer<never> = ConfigProvider.layer(
		ConfigProvider.fromEnvRecord({}),
	),
	options?: {
		providers?: HashMap.HashMap<string, AuthProvider>;
	},
) {
	const repositories = Layer.mergeAll(
		DrizzleSqliteLoginAttemptRepository,
		DrizzleSqliteAuthenticationRepository,
		DrizzleSqliteSessionRepository,
		DrizzleSqliteTransaction,
	);
	const handler = yield* HttpRouter.toHttpEffect(
		RootApiLive.pipe(
			HttpRouter.provideRequest(
				Layer.mergeAll(
					FieldRegistryService.layer(namespaces),
					InMemoryTopicBroker,
					UrlPath.layer,
					FetchHttpClient.layer,
					repositories,
				),
			),
			Layer.provide(middleware),
			Layer.provide(ServiceAccountAuthenticationMiddlewareLive),
			Layer.provide(AdminTierMiddlewareLive),
			Layer.provide(SuperadminMiddlewareLive),
			Layer.provide(repositories),
			Layer.provide(InMemoryRoleStore),
			Layer.provide(InMemoryServiceAccountStore),
			Layer.provide(InMemoryReplicantRepository),
			Layer.provide(
				DerivationEngineService.layer.pipe(
					Layer.provide(InMemoryReplicantRepository),
				),
			),
			Layer.provide(
				Layer.succeed(
					AuthProviderRegistry,
					options?.providers ?? HashMap.empty<string, AuthProvider>(),
				),
			),
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
					NodeCrypto.layer,
					Reactivity.layer,
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
					User.make({
						authentication: { issuer: "dev", subject: "op", displayName: "Op" },
						roles: [{ namespace: "perms", name: RoleName("producer") }],
						globalRoles: [],
					}),
				),
			);
			const res = yield* handler(new Request("http://x/api/internal/me"));
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({
				identity: {
					_tag: "user",
					authentication: { issuer: "dev", subject: "op", displayName: "Op" },
					roles: [{ namespace: "perms", name: "producer" }],
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
				loginAttempt: { provider: "dev", state: "s" },
			}),
		callback: () =>
			Effect.succeed({ issuer: "dev", subject: "alice", displayName: "Alice" }),
	};
	const providers = HashMap.make(["dev", devProvider] as const);

	const loginHandler = () =>
		webHandler([], undefined, undefined, { providers });

	const loginAttemptCookieOf = (res: Response) => {
		const match = (res.headers.get("set-cookie") ?? "").match(
			/nodecg\.login_attempt=([^;]+)/,
		);
		if (match === null) {
			throw new Error("login did not set the login attempt cookie");
		}
		return match[1];
	};

	const subPathEnv = ConfigProvider.layer(
		ConfigProvider.fromEnvRecord({ BASE_URL: "http://x/s/nodecg" }),
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

	it.effect("a callback with a stored returnTo redirects there", () =>
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
						headers: {
							cookie: `nodecg.login_attempt=${loginAttemptCookieOf(login)}`,
						},
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
							headers: {
								cookie: `nodecg.login_attempt=${loginAttemptCookieOf(login)}`,
							},
						},
					),
				);
				expect(callback.status).toBe(200);
				expect(yield* Effect.promise(() => callback.text())).toBe("Success");
			}),
	);

	const logIn = Effect.fn(function* (
		handler: (request: Request) => Effect.Effect<Response>,
	) {
		const login = yield* handler(
			new Request("http://x/api/internal/authentication/login/dev"),
		);
		const callback = yield* handler(
			new Request("http://x/api/internal/authentication/callback/dev?state=s", {
				headers: {
					cookie: `nodecg.login_attempt=${loginAttemptCookieOf(login)}`,
				},
			}),
		);
		const match = (callback.headers.get("set-cookie") ?? "").match(
			/nodecg\.sid=([^;]+)/,
		);
		const sid = match?.[1];
		if (typeof sid === "undefined") {
			throw new Error("callback did not set the session cookie");
		}
		return sid;
	});

	const meRequest = (sid: string) =>
		new Request("http://x/api/internal/me", {
			headers: { cookie: `nodecg.sid=${sid}` },
		});

	it.effect(
		"the session a callback creates resolves to the logged-in user",
		() =>
			Effect.gen(function* () {
				const handler = yield* loginHandler();
				const sid = yield* logIn(handler);
				const me = yield* handler(meRequest(sid));
				expect(me.status).toBe(200);
				expect(yield* json(me)).toEqual({
					identity: {
						_tag: "user",
						authentication: {
							issuer: "dev",
							subject: "alice",
							displayName: "Alice",
						},
						roles: [],
						globalRoles: [],
					},
					namespaces: {},
				});
			}),
	);

	it.effect("a request with a live session renews its cookie", () =>
		Effect.gen(function* () {
			const handler = yield* loginHandler();
			const sid = yield* logIn(handler);
			const me = yield* handler(meRequest(sid));
			expect(me.headers.get("set-cookie")).toBe(
				`nodecg.sid=${sid}; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`,
			);
		}),
	);

	it.effect("a request with an unknown session sets no cookie", () =>
		Effect.gen(function* () {
			const handler = yield* loginHandler();
			const me = yield* handler(meRequest("unknown"));
			expect(me.headers.get("set-cookie")).toBeNull();
		}),
	);

	it.effect("logout ends the session and clears its cookie", () =>
		Effect.gen(function* () {
			const handler = yield* loginHandler();
			const sid = yield* logIn(handler);
			const logout = yield* handler(
				new Request("http://x/api/internal/authentication/logout", {
					method: "POST",
					headers: { cookie: `nodecg.sid=${sid}` },
				}),
			);
			expect(logout.status).toBe(204);
			expect(logout.headers.get("set-cookie")).toBe(
				"nodecg.sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
			);
			expect(yield* json(yield* handler(meRequest(sid)))).toEqual({
				identity: { _tag: "anonymous" },
				namespaces: {},
			});
		}),
	);

	it.effect("a callback with an unknown login attempt clears its cookie", () =>
		Effect.gen(function* () {
			const handler = yield* loginHandler();
			const callback = yield* handler(
				new Request(
					"http://x/api/internal/authentication/callback/dev?state=s",
					{ headers: { cookie: "nodecg.login_attempt=unknown" } },
				),
			);
			expect(callback.status).toBe(400);
			expect(callback.headers.get("set-cookie")).toBe(
				"nodecg.login_attempt=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
			);
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

	it.effect("fails to start when the login attempt TTL does not decode", () =>
		Effect.gen(function* () {
			const error = yield* webHandler(
				[],
				undefined,
				ConfigProvider.layer(
					ConfigProvider.fromEnvRecord({ LOGIN_ATTEMPT_TTL: "soon" }),
				),
				{ providers },
			).pipe(Effect.flip);
			expect(error).toBeInstanceOf(Config.ConfigError);
		}),
	);

	it.effect("fails to start when the session TTL does not decode", () =>
		Effect.gen(function* () {
			const error = yield* webHandler(
				[],
				undefined,
				ConfigProvider.layer(
					ConfigProvider.fromEnvRecord({ SESSION_TTL: "soon" }),
				),
				{ providers },
			).pipe(Effect.flip);
			expect(error).toBeInstanceOf(Config.ConfigError);
		}),
	);

	it.effect("login keeps the login attempt cookie for the configured TTL", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler(
				[],
				undefined,
				ConfigProvider.layer(
					ConfigProvider.fromEnvRecord({ LOGIN_ATTEMPT_TTL: "5 minutes" }),
				),
				{ providers },
			);
			const login = yield* handler(
				new Request("http://x/api/internal/authentication/login/dev"),
			);
			expect(login.headers.get("set-cookie")).toMatch(
				/^nodecg\.login_attempt=[^;]+; Max-Age=300; Path=\/; HttpOnly; SameSite=Lax$/,
			);
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
						loginAttempt: { provider: "dev", state: "s" },
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
	function rolesRequest(
		action: "grant" | "revoke",
		name: string,
		namespace = "show",
	) {
		return new Request(`http://x/api/internal/roles/${action}`, {
			method: "POST",
			body: JSON.stringify({
				login: { issuer: "dev", subject: "operator" },
				role: { namespace, name },
			}),
			headers: { "content-type": "application/json" },
		});
	}

	const admin = asIdentity(
		User.make({
			authentication: { issuer: "dev", subject: "boss", displayName: "Boss" },
			roles: [],
			globalRoles: ["admin"],
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
					User.make({
						authentication: { issuer: "dev", subject: "op", displayName: "Op" },
						roles: [{ namespace: "show", name: RoleName("producer") }],
						globalRoles: [],
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
				const handler = yield* webHandler([show], admin);
				const grant = yield* handler(rolesRequest("grant", "producer"));
				expect(grant.status).toBe(200);
				expect(yield* json(grant)).toEqual({
					roles: [{ namespace: "show", name: "producer" }],
				});

				const revoke = yield* handler(rolesRequest("revoke", "producer"));
				expect(revoke.status).toBe(200);
				expect(yield* json(revoke)).toEqual({ roles: [] });
			}),
	);

	it.effect(
		"403 when an admin grants a role the namespace does not declare",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([show], admin);
				for (const name of ["superadmin", "admin", "server", "ghost"]) {
					expect((yield* handler(rolesRequest("grant", name))).status).toBe(
						403,
					);
				}
				expect(
					(yield* handler(rolesRequest("grant", "producer", "stage"))).status,
				).toBe(403);
			}),
	);
});

describe("admin roles", () => {
	const adminRoleRequest = (
		action: "grant" | "revoke",
		target: unknown,
		role: string,
	) =>
		postRequest(`http://x/api/internal/admin-roles/${action}`, {
			target,
			role,
		});

	const user = {
		_tag: "user",
		login: { issuer: "dev", subject: "operator" },
	};

	const superadmin = asIdentity(
		User.make({
			authentication: { issuer: "dev", subject: "root", displayName: "Root" },
			roles: [],
			globalRoles: ["superadmin"],
		}),
	);

	const admin = asIdentity(
		User.make({
			authentication: { issuer: "dev", subject: "boss", displayName: "Boss" },
			roles: [],
			globalRoles: ["admin"],
		}),
	);

	const decodeId = Schema.decodeUnknownSync(
		Schema.Struct({ id: Schema.String }),
	);

	const createServiceAccount = Effect.fn(function* (
		handler: (request: Request) => Effect.Effect<Response>,
	) {
		const res = yield* handler(
			postRequest("http://x/api/internal/service-accounts", {
				displayName: "bot",
			}),
		);
		return decodeId(yield* json(res));
	});

	it.effect("403 for an anonymous caller", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([]);
			expect(
				(yield* handler(adminRoleRequest("grant", user, "admin"))).status,
			).toBe(403);
			expect(
				(yield* handler(adminRoleRequest("revoke", user, "admin"))).status,
			).toBe(403);
		}),
	);

	it.effect("403 for an admin-tier caller who is not a superadmin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], admin);
			expect(
				(yield* handler(adminRoleRequest("grant", user, "admin"))).status,
			).toBe(403);
		}),
	);

	it.effect("superadmin grants and revokes the admin tier for a user", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], superadmin);
			const grant = yield* handler(adminRoleRequest("grant", user, "admin"));
			expect(grant.status).toBe(200);
			expect(yield* json(grant)).toEqual({ roles: ["admin"] });

			const revoke = yield* handler(adminRoleRequest("revoke", user, "admin"));
			expect(revoke.status).toBe(200);
			expect(yield* json(revoke)).toEqual({ roles: [] });
		}),
	);

	it.effect("superadmin grants superadmin to a user", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], superadmin);
			const res = yield* handler(adminRoleRequest("grant", user, "superadmin"));
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({ roles: ["superadmin"] });
		}),
	);

	it.effect("400 for a payload role outside the admin tier", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], superadmin);
			expect(
				(yield* handler(adminRoleRequest("grant", user, "producer"))).status,
			).toBe(400);
		}),
	);

	it.effect("superadmin grants the admin tier to a service account", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], superadmin);
			const { id } = yield* createServiceAccount(handler);
			const res = yield* handler(
				adminRoleRequest("grant", { _tag: "serviceAccount", id }, "admin"),
			);
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({ roles: ["admin"] });
		}),
	);

	it.effect(
		"404 when granting the admin tier to an unknown service account",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([], superadmin);
				expect(
					(yield* handler(
						adminRoleRequest(
							"grant",
							{ _tag: "serviceAccount", id: "ghost" },
							"admin",
						),
					)).status,
				).toBe(404);
			}),
	);
});

describe("claim superadmin", () => {
	const claimUrl = "http://x/api/internal/authentication/claim-superadmin";
	const claimRequest = (token: string) => postRequest(claimUrl, { token });

	const user = asIdentity(
		User.make({
			authentication: {
				issuer: "dev",
				subject: "founder",
				displayName: "Founder",
			},
			roles: [],
			globalRoles: [],
		}),
	);

	const withClaimToken = ConfigProvider.layer(
		ConfigProvider.fromEnvRecord({
			SUPERADMIN_CLAIM_TOKEN: "super-secret-claim-token",
		}),
	);

	it.effect(
		"grants superadmin to the logged-in user presenting the token",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([], user, withClaimToken);
				const res = yield* handler(claimRequest("super-secret-claim-token"));
				expect(res.status).toBe(200);
				expect(yield* json(res)).toEqual({ roles: ["superadmin"] });
			}),
	);

	it.effect(
		"a wrong token keeps the window open and the first success closes it",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([], user, withClaimToken);
				expect(
					(yield* handler(claimRequest("wrong-token-of-real-length"))).status,
				).toBe(403);
				expect(
					(yield* handler(claimRequest("super-secret-claim-token"))).status,
				).toBe(200);
				expect(
					(yield* handler(claimRequest("super-secret-claim-token"))).status,
				).toBe(403);
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
			const handler = yield* webHandler([], user);
			expect(
				(yield* handler(claimRequest("super-secret-claim-token"))).status,
			).toBe(403);
		}),
	);

	it.effect("429 after too many attempts in the window", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], user, withClaimToken);
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
			const bySid = Layer.succeed(UserAuthenticationMiddleware, {
				cookie: (httpEffect, { credential }) =>
					Effect.provideService(
						httpEffect,
						CurrentIdentity,
						Redacted.value(credential) === "founder"
							? User.make({
									authentication: {
										issuer: "dev",
										subject: "founder",
										displayName: "Founder",
									},
									roles: [],
									globalRoles: [],
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
	const founderIdentity = User.make({
		authentication: {
			issuer: "dev",
			subject: "founder",
			displayName: "Founder",
		},
		roles: [],
		globalRoles: [],
	});
	const adminIdentity = User.make({
		authentication: { issuer: "dev", subject: "boss", displayName: "Boss" },
		roles: [],
		globalRoles: ["admin"],
	});
	const admin = asIdentity(adminIdentity);

	const identityBySubject = (identities: Record<string, Identity>) =>
		Layer.succeed(UserAuthenticationMiddleware, {
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
		root: User.make({
			authentication: { issuer: "dev", subject: "root", displayName: "Root" },
			roles: [],
			globalRoles: ["superadmin"],
		}),
	});

	const grantFounderAdminRequest = () =>
		postRequest("http://x/api/internal/admin-roles/grant", {
			target: { _tag: "user", login: { issuer: "dev", subject: "founder" } },
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
			login: { issuer: "dev", subject },
			role: { namespace: "show", name: role },
		});

	const createServiceAccountRequest = (displayName: string) =>
		postRequest("http://x/api/internal/service-accounts", { displayName });

	const serviceAccountRoleRequest = (id: string, role: string) =>
		postRequest(`http://x/api/internal/service-accounts/${id}/roles`, {
			namespace: "show",
			name: role,
		});

	const listServiceAccountsRequest = () =>
		new Request("http://x/api/internal/service-accounts");

	const decodeId = Schema.decodeUnknownSync(
		Schema.Struct({ id: Schema.String }),
	);

	const decodeAssignmentsDocument = Schema.decodeUnknownSync(
		Schema.Struct({
			assignments: Schema.Array(
				Schema.Struct({
					login: Schema.Struct({ subject: Schema.String }),
					roles: Schema.Array(
						Schema.Struct({ namespace: Schema.String, name: Schema.String }),
					),
				}),
			),
		}),
	);

	it.effect("exports user and service account assignments for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], admin);
			yield* handler(grantRequest("operator", "producer"));
			const { id } = decodeId(
				yield* json(yield* handler(createServiceAccountRequest("scoreboard"))),
			);
			yield* handler(serviceAccountRoleRequest(id, "viewer"));
			yield* handler(createServiceAccountRequest("idle"));
			const res = yield* handler(exportRequest());
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({
				version: 0,
				assignments: [
					{
						_tag: "user",
						login: { issuer: "dev", subject: "operator" },
						roles: [{ namespace: "show", name: "producer" }],
						globalRoles: [],
					},
					{
						_tag: "serviceAccount",
						id,
						roles: [{ namespace: "show", name: "viewer" }],
						globalRoles: [],
					},
				],
			});
		}),
	);

	it.effect(
		"merge adds roles to the named identities and leaves others alone",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([show], admin);
				yield* handler(grantRequest("operator", "producer"));
				yield* handler(grantRequest("other", "judge"));
				const res = yield* handler(
					importRequest("merge", [
						{
							_tag: "user",
							login: { issuer: "dev", subject: "operator" },
							roles: [{ namespace: "show", name: "viewer" }],
							globalRoles: [],
						},
					]),
				);
				expect(res.status).toBe(204);
				const doc = decodeAssignmentsDocument(
					yield* json(yield* handler(exportRequest())),
				);
				expect(doc.assignments).toHaveLength(2);
				const operator = doc.assignments.find(
					(a) => a.login.subject === "operator",
				);
				const other = doc.assignments.find((a) => a.login.subject === "other");
				expect(operator?.roles).toHaveLength(2);
				expect(operator?.roles).toEqual(
					expect.arrayContaining([
						{ namespace: "show", name: "producer" },
						{ namespace: "show", name: "viewer" },
					]),
				);
				expect(other?.roles).toEqual([{ namespace: "show", name: "judge" }]);
			}),
	);

	it.effect("replace overwrites the whole store", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], admin);
			yield* handler(grantRequest("operator", "producer"));
			yield* handler(grantRequest("other", "judge"));
			const res = yield* handler(
				importRequest("replace", [
					{
						_tag: "user",
						login: { issuer: "dev", subject: "operator" },
						roles: [{ namespace: "show", name: "viewer" }],
						globalRoles: [],
					},
				]),
			);
			expect(res.status).toBe(204);
			expect(yield* json(yield* handler(exportRequest()))).toEqual({
				version: 0,
				assignments: [
					{
						_tag: "user",
						login: { issuer: "dev", subject: "operator" },
						roles: [{ namespace: "show", name: "viewer" }],
						globalRoles: [],
					},
				],
			});
		}),
	);

	it.effect(
		"replace clears roles of service accounts absent from the document",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([show], admin);
				const { id } = decodeId(
					yield* json(
						yield* handler(createServiceAccountRequest("scoreboard")),
					),
				);
				yield* handler(serviceAccountRoleRequest(id, "viewer"));
				expect((yield* handler(importRequest("replace", []))).status).toBe(204);
				expect(
					yield* json(yield* handler(listServiceAccountsRequest())),
				).toEqual({
					serviceAccounts: [
						{ id, displayName: "scoreboard", roles: [], globalRoles: [] },
					],
				});
			}),
	);

	it.effect("excludes the admin tier from the export", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], tiered, withClaimToken);
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
						_tag: "user",
						login: { issuer: "dev", subject: "founder" },
						roles: [{ namespace: "show", name: "producer" }],
						globalRoles: [],
					},
				],
			});
		}),
	);

	it.effect("excludes a subject who holds only the admin tier", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], tiered, withClaimToken);
			expect((yield* handler(withSid(claimRequest(), "founder"))).status).toBe(
				200,
			);
			expect(
				yield* json(yield* handler(withSid(exportRequest(), "boss"))),
			).toEqual({ version: 0, assignments: [] });
		}),
	);

	it.effect("merge keeps an admin tier the document does not mention", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], tiered, withClaimToken);
			yield* handler(withSid(claimRequest(), "founder"));
			expect(
				(yield* handler(
					withSid(
						importRequest("merge", [
							{
								_tag: "user",
								login: { issuer: "dev", subject: "founder" },
								roles: [{ namespace: "show", name: "viewer" }],
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
			).toEqual({
				roles: expect.arrayContaining(["superadmin", "admin"]),
			});
		}),
	);

	it.effect(
		"replace keeps the admin tier of an identity absent from the document",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([show], tiered, withClaimToken);
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
				).toEqual({
					roles: expect.arrayContaining(["superadmin", "admin"]),
				});
			}),
	);

	it.effect("400 with a detail message for an admin-tier global role", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], admin);
			const res = yield* handler(
				importRequest("merge", [
					{
						_tag: "user",
						login: { issuer: "dev", subject: "operator" },
						roles: [],
						globalRoles: ["superadmin"],
					},
				]),
			);
			expect(res.status).toBe(400);
			expect(yield* json(res)).toEqual({
				_tag: "RoleImportError",
				message:
					'role "superadmin" cannot be assigned via import (entry {"_tag":"user","login":{"issuer":"dev","subject":"operator"}})',
			});
		}),
	);

	it.effect("400 for an undeclarable role on an entry", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], admin);
			expect(
				(yield* handler(
					importRequest("merge", [
						{
							_tag: "user",
							login: { issuer: "dev", subject: "operator" },
							roles: [{ namespace: "show", name: "server" }],
							globalRoles: [],
						},
					]),
				)).status,
			).toBe(400);
		}),
	);

	it.effect("400 with a detail message for an unknown service account id", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], admin);
			const res = yield* handler(
				importRequest("merge", [
					{
						_tag: "serviceAccount",
						id: "ghost",
						roles: [{ namespace: "show", name: "viewer" }],
						globalRoles: [],
					},
				]),
			);
			expect(res.status).toBe(400);
			expect(yield* json(res)).toEqual({
				_tag: "RoleImportError",
				message: 'unknown service account id "ghost"',
			});
		}),
	);

	it.effect("400 for duplicate entries for one identity", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], admin);
			expect(
				(yield* handler(
					importRequest("merge", [
						{
							_tag: "user",
							login: { issuer: "dev", subject: "operator" },
							roles: [{ namespace: "show", name: "viewer" }],
							globalRoles: [],
						},
						{
							_tag: "user",
							login: { issuer: "dev", subject: "operator" },
							roles: [{ namespace: "show", name: "judge" }],
							globalRoles: [],
						},
					]),
				)).status,
			).toBe(400);
		}),
	);
});

describe("service accounts", () => {
	const createRequest = () =>
		new Request("http://x/api/internal/service-accounts", {
			method: "POST",
			body: JSON.stringify({ displayName: "scoreboard" }),
			headers: { "content-type": "application/json" },
		});

	const admin = asIdentity(
		User.make({
			authentication: { issuer: "dev", subject: "boss", displayName: "Boss" },
			roles: [],
			globalRoles: ["admin"],
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
			const handler = yield* webHandler([show], admin);
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
		new Request("http://x/api/internal/service-accounts", { method: "GET" });

	const revokeRequest = (id: string) =>
		new Request(`http://x/api/internal/service-accounts/${id}`, {
			method: "DELETE",
		});

	it.effect("lists created keys without their token for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], admin);
			const { id } = decodeCreated(
				yield* json(yield* handler(createRequest())),
			);
			const res = yield* handler(listRequest());
			expect(res.status).toBe(200);
			expect(yield* json(res)).toEqual({
				serviceAccounts: [
					{ id, displayName: "scoreboard", roles: [], globalRoles: [] },
				],
			});
		}),
	);

	it.effect("revokes a key and drops it from the listing for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], admin);
			const { id } = decodeCreated(
				yield* json(yield* handler(createRequest())),
			);
			expect((yield* handler(revokeRequest(id))).status).toBe(204);
			expect(yield* json(yield* handler(listRequest()))).toEqual({
				serviceAccounts: [],
			});
		}),
	);

	it.effect("404 when revoking an unknown id for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], admin);
			expect((yield* handler(revokeRequest("ghost"))).status).toBe(404);
		}),
	);

	const refreshRequest = (id: string) =>
		new Request(`http://x/api/internal/service-accounts/${id}/refresh`, {
			method: "POST",
		});

	it.effect("refreshes a key, keeping id and display name, for an admin", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([show], admin);
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

	const grantRoleRequest = (id: string, name: string, namespace = "show") =>
		new Request(`http://x/api/internal/service-accounts/${id}/roles`, {
			method: "POST",
			body: JSON.stringify({ namespace, name }),
			headers: { "content-type": "application/json" },
		});

	const revokeRoleRequest = (id: string, role: string) =>
		new Request(
			`http://x/api/internal/service-accounts/${id}/namespaces/show/roles/${role}`,
			{ method: "DELETE" },
		);

	it.effect(
		"grants a named role and returns the updated set for an admin",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([show], admin);
				const { id } = decodeCreated(
					yield* json(yield* handler(createRequest())),
				);
				const res = yield* handler(grantRoleRequest(id, "viewer"));
				expect(res.status).toBe(200);
				expect(yield* json(res)).toEqual({
					roles: [{ namespace: "show", name: "viewer" }],
				});
			}),
	);

	it.effect(
		"403 when granting a service account a role the namespace does not declare",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([show], admin);
				const { id } = decodeCreated(
					yield* json(yield* handler(createRequest())),
				);
				for (const name of ["admin", "server", "ghost"]) {
					expect((yield* handler(grantRoleRequest(id, name))).status).toBe(403);
				}
				expect(
					(yield* handler(grantRoleRequest(id, "viewer", "stage"))).status,
				).toBe(403);
			}),
	);

	it.effect(
		"revokes a named role and returns the remaining set for an admin",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([show], admin);
				const { id } = decodeCreated(
					yield* json(yield* handler(createRequest())),
				);
				yield* handler(grantRoleRequest(id, "viewer"));
				yield* handler(grantRoleRequest(id, "judge"));
				const res = yield* handler(revokeRoleRequest(id, "viewer"));
				expect(res.status).toBe(200);
				expect(yield* json(res)).toEqual({
					roles: [{ namespace: "show", name: "judge" }],
				});
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
		User.make({
			authentication: { issuer: "dev", subject: "boss", displayName: "Boss" },
			roles: [],
			globalRoles: ["admin"],
		}),
	);

	const decodeToken = Schema.decodeUnknownSync(
		Schema.Struct({ token: Schema.String }),
	);

	const mintKey = Effect.fn(function* (
		handler: (request: Request) => Effect.Effect<Response>,
	) {
		const res = yield* handler(
			new Request("http://x/api/internal/service-accounts", {
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
