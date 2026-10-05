import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { type ResolvedPermission, FieldDecodeError } from "@nodecg-next/core";
import {
	UserAuthenticationMiddleware,
	AnonymousIdentitySchema,
	CurrentIdentity,
	User,
	UserId,
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
import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import {
	DerivationEngineService,
	UnknownReplicant,
} from "../derivation-graph.ts";
import { RpcHandlerError } from "../field-builders/build-rpc.ts";
import { fieldInternal } from "../field-builders/field-internal-key.ts";
import { FieldPermissionDenied } from "../field-builders/permission.ts";
import {
	NamespaceRegistryService,
	type RegisteredNamespace,
} from "../namespace-registry.ts";
import { DrizzleSqliteDatabaseService } from "../services/database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { DrizzleSqliteAccountRepository } from "../services/repository/account/drizzle-sqlite-account-repository.ts";
import { AuthenticationRepositoryService } from "../services/repository/authentication/authentication-repository.ts";
import { DrizzleSqliteAuthenticationRepository } from "../services/repository/authentication/drizzle-sqlite-authentication-repository.ts";
import { DrizzleSqliteLoginAttemptRepository } from "../services/repository/login-attempt/drizzle-sqlite-login-attempt-repository.ts";
import { InMemoryReplicantRepository } from "../services/repository/replicant/in-memory-replicant-repository.ts";
import { DrizzleSqliteRoleRepository } from "../services/repository/role/drizzle-sqlite-role-repository.ts";
import { DrizzleSqliteServiceAccountRepository } from "../services/repository/service-account/drizzle-sqlite-service-account-repository.ts";
import { DrizzleSqliteSessionRepository } from "../services/repository/session/drizzle-sqlite-session-repository.ts";
import { DrizzleSqliteUserRepository } from "../services/repository/user/drizzle-sqlite-user-repository.ts";
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
		loggedIn?: ReadonlyArray<string>;
	},
) {
	const repositories = Layer.mergeAll(
		DrizzleSqliteLoginAttemptRepository,
		DrizzleSqliteAuthenticationRepository,
		DrizzleSqliteSessionRepository,
		DrizzleSqliteAccountRepository,
		DrizzleSqliteRoleRepository,
		DrizzleSqliteServiceAccountRepository,
		DrizzleSqliteUserRepository,
		DrizzleSqliteTransaction,
	);
	const loggedIn = Layer.effectDiscard(
		Effect.gen(function* () {
			const authentications = yield* AuthenticationRepositoryService;
			yield* Effect.forEach(options?.loggedIn ?? [], (subject) =>
				authentications.findOrCreateAuthentication(
					{ issuer: "dev", subject },
					subject,
				),
			);
		}),
	);
	const handler = yield* HttpRouter.toHttpEffect(
		RootApiLive.pipe(
			HttpRouter.provideRequest(
				Layer.mergeAll(
					NamespaceRegistryService.layer(namespaces),
					InMemoryTopicBroker,
					UrlPath.layer,
					FetchHttpClient.layer,
					repositories,
					ConfiguredSuperadmins.layer,
				).pipe(Layer.provideMerge(NodeCrypto.layer)),
			),
			Layer.provide(middleware),
			Layer.provide(ServiceAccountAuthenticationMiddlewareLive),
			Layer.provide(AdminTierMiddlewareLive),
			Layer.provide(SuperadminMiddlewareLive),
			Layer.provide(loggedIn),
			Layer.provide(repositories),
			Layer.provide(ConfiguredSuperadmins.layer),
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
						id: UserId.make("op"),
						authentication: { issuer: "dev", subject: "op" },
						displayName: "Op",
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
					id: "op",
					authentication: { issuer: "dev", subject: "op" },
					displayName: "Op",
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
			Effect.succeed({
				authentication: { issuer: "dev", subject: "alice" },
				displayName: "Alice",
			}),
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
						id: expect.any(String),
						authentication: { issuer: "dev", subject: "alice" },
						displayName: "Alice",
						roles: [],
						globalRoles: [],
					},
					namespaces: {},
				});
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
					Effect.succeed({
						authentication: { issuer: "dev", subject: "a" },
						displayName: "A",
					}),
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

describe("claim superadmin", () => {
	const claimUrl = "http://x/api/internal/authentication/claim-superadmin";
	const claimRequest = (token: string) => postRequest(claimUrl, { token });

	const user = asIdentity(
		User.make({
			id: UserId.make("founder"),
			authentication: { issuer: "dev", subject: "founder" },
			displayName: "Founder",
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
		"a wrong token keeps the window open and the first success closes it",
		() =>
			Effect.gen(function* () {
				const handler = yield* webHandler([], user, withClaimToken, {
					loggedIn: ["founder"],
				});
				expect(
					(yield* handler(claimRequest("wrong-token-of-real-length"))).status,
				).toBe(403);
				expect(
					(yield* handler(claimRequest("super-secret-claim-token"))).status,
				).toBe(204);
				expect(
					(yield* handler(claimRequest("super-secret-claim-token"))).status,
				).toBe(403);
			}),
	);

	it.effect("401 for an anonymous caller", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([], undefined, withClaimToken);
			expect(
				(yield* handler(claimRequest("super-secret-claim-token"))).status,
			).toBe(401);
		}),
	);

	it.effect("403 while a superadmin is configured", () =>
		Effect.gen(function* () {
			const dev: AuthProvider = {
				name: "dev",
				issuer: "dev",
				authorize: () => Effect.die("unused"),
				callback: () => Effect.die("unused"),
			};
			const handler = yield* webHandler(
				[],
				user,
				ConfigProvider.layer(
					ConfigProvider.fromEnvRecord({
						SUPERADMIN_CLAIM_TOKEN: "super-secret-claim-token",
						SUPERADMINS: "dev:root",
					}),
				),
				{ providers: HashMap.make(["dev", dev]) },
			);
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

	it.effect("an anonymous flood does not consume the claim budget", () =>
		Effect.gen(function* () {
			const bySid = Layer.succeed(UserAuthenticationMiddleware, {
				cookie: (httpEffect, { credential }) =>
					Effect.provideService(
						httpEffect,
						CurrentIdentity,
						Redacted.value(credential) === "founder"
							? User.make({
									id: UserId.make("founder"),
									authentication: { issuer: "dev", subject: "founder" },
									displayName: "Founder",
									roles: [],
									globalRoles: [],
								})
							: AnonymousIdentitySchema.make({}),
					),
			});
			const handler = yield* webHandler([], bySid, withClaimToken, {
				loggedIn: ["founder"],
			});
			const withSid = (request: Request, sid: string) => {
				request.headers.set("cookie", `nodecg.sid=${sid}`);
				return request;
			};
			for (let attempt = 0; attempt < 10; attempt++) {
				expect(
					(yield* handler(claimRequest("super-secret-claim-token"))).status,
				).toBe(401);
			}
			expect(
				(yield* handler(
					withSid(claimRequest("super-secret-claim-token"), "founder"),
				)).status,
			).toBe(204);
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
			id: UserId.make("boss"),
			authentication: { issuer: "dev", subject: "boss" },
			displayName: "Boss",
			roles: [],
			globalRoles: ["admin"],
		}),
	);

	const decodeKey = Schema.decodeUnknownSync(
		Schema.Struct({ serviceAccountId: Schema.String, token: Schema.String }),
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
		return decodeKey(yield* json(res));
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
			const handler = yield* webHandler([countNamespace()], admin, undefined, {
				loggedIn: ["boss"],
			});
			const { token } = yield* mintKey(handler);
			const res = yield* handler(
				new Request(publicGetUrl, {
					headers: { authorization: `Bearer ${token}` },
				}),
			);
			expect(res.status).toBe(200);
			expect(yield* json(res)).toBe(42);
		}),
	);

	it.effect("a refreshed key replaces the old one", () =>
		Effect.gen(function* () {
			const handler = yield* webHandler([countNamespace()], admin, undefined, {
				loggedIn: ["boss"],
			});
			const created = yield* mintKey(handler);
			const refreshed = decodeKey(
				yield* json(
					yield* handler(
						new Request(
							`http://x/api/internal/service-accounts/${created.serviceAccountId}/refresh`,
							{ method: "POST" },
						),
					),
				),
			);

			const withOld = yield* handler(
				new Request(publicGetUrl, {
					headers: { authorization: `Bearer ${created.token}` },
				}),
			);
			const withNew = yield* handler(
				new Request(publicGetUrl, {
					headers: { authorization: `Bearer ${refreshed.token}` },
				}),
			);
			expect([withOld.status, withNew.status]).toStrictEqual([401, 200]);
		}),
	);
});
