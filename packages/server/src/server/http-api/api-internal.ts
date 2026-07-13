import {
	Cookies,
	HttpApiBuilder,
	HttpApiError,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { isAdminTier } from "@nodecg/core";
import {
	CurrentIdentity,
	isUndeclarableRole,
	sessionCookieName,
	sessionCookieSecurity,
} from "@nodecg/internal";
import {
	type Duration,
	Effect,
	Either,
	HashMap,
	Layer,
	Match,
	Option,
} from "effect";

import { AuthProviderRegistry } from "../../auth/auth-provider.ts";
import { config } from "../../server-config.ts";
import { MachineClientStoreService } from "../../services/machine-client-store/machine-client-store.ts";
import { RoleStoreService } from "../../services/role-store/role-store.ts";
import { SessionStoreService } from "../../services/session-store/session-store.ts";
import { StashStoreService } from "../../services/stash-store/stash-store.ts";
import { RootApi } from "../root-api.ts";
import {
	callRpc,
	getComputed,
	getReplicant,
	publishTopic,
	updateReplicant,
} from "./shared.ts";

const stashCookieName = "nodecg.login";

const cookieOptions: NonNullable<Cookies.Cookie["options"]> = {
	httpOnly: true,
	sameSite: "lax",
	secure: false,
	path: "/",
};

const setStash =
	(value: string, maxAge: Duration.DurationInput) =>
	(response: HttpServerResponse.HttpServerResponse) =>
		response.pipe(
			HttpServerResponse.setCookie(stashCookieName, value, {
				...cookieOptions,
				maxAge,
			}),
			// TODO: is this a correct silencing?
			Effect.catchTag(
				"CookieError",
				() => new HttpApiError.InternalServerError(),
			),
		);

const clearStash = setStash("", 0);

const setSessionCookie = (value: string, maxAge: Duration.DurationInput) =>
	HttpApiBuilder.securitySetCookie(sessionCookieSecurity, value, {
		...cookieOptions,
		maxAge,
	});

const callbackUri = (origin: string, provider: string) =>
	`${origin}/api/internal/authentication/callback/${provider}`;

const AuthenticationGroupLive = HttpApiBuilder.group(
	RootApi,
	"Authentication",
	(handlers) =>
		Effect.gen(function* () {
			const ttl = yield* config.sessionTtl;
			const origin = yield* config.origin;
			const registry = yield* AuthProviderRegistry;
			const sessions = yield* SessionStoreService;
			const stashes = yield* StashStoreService;

			return handlers
				.handle("me", () =>
					Effect.gen(function* () {
						const identity = yield* CurrentIdentity;
						return { identity };
					}),
				)
				.handle("login", ({ path: { provider: name } }) =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const provider = HashMap.get(registry, name);
						if (Option.isNone(provider)) {
							return HttpServerResponse.text(
								"Unknown authentication provider",
								{ status: 404 },
							);
						}
						const redirect = yield* provider.value
							.authorize({
								redirectUri: callbackUri(origin, name),
								searchParams: new URL(request.url, "http://example.com")
									.searchParams,
							})
							.pipe(Effect.either);
						if (Either.isLeft(redirect)) {
							return HttpServerResponse.text(
								"Authentication provider unavailable",
								{ status: 502 },
							);
						}
						const stashId = yield* stashes.create(redirect.right.stash);
						return yield* HttpServerResponse.redirect(redirect.right.url, {
							status: 302,
						}).pipe(setStash(stashId, "10 minutes")); // TODO: avoid hard-coded duration
					}),
				)
				.handle("callback", ({ path: { provider: name } }) =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const provider = HashMap.get(registry, name);
						if (Option.isNone(provider)) {
							return HttpServerResponse.text(
								"Unknown authentication provider",
								{
									status: 404,
								},
							);
						}
						const stashId = request.cookies[stashCookieName];
						if (typeof stashId === "undefined") {
							return HttpServerResponse.text("Invalid or missing login state", {
								status: 400,
							});
						}
						const stash = yield* stashes.lookup(stashId);
						if (Option.isNone(stash)) {
							return HttpServerResponse.text("Invalid or missing login state", {
								status: 400,
							});
						}
						yield* stashes.revoke(stashId);
						const account = yield* provider.value
							.callback({
								redirectUri: callbackUri(origin, name),
								searchParams: new URL(request.url, "http://example.com")
									.searchParams,
								stash: stash.value,
							})
							.pipe(
								Effect.tapError((error) =>
									Effect.logError(
										`Authentication callback failed: ${error.message}`,
									),
								),
								Effect.either,
							);
						if (Either.isLeft(account)) {
							return yield* Match.value(account.left).pipe(
								Match.tag("OAuthStateMismatchError", () =>
									HttpServerResponse.text("OAuth state mismatch", {
										status: 400,
									}).pipe(clearStash),
								),
								Match.tag("ProviderDiscoveryError", () =>
									HttpServerResponse.text(
										"Authentication provider unavailable",
										{ status: 502 },
									).pipe(clearStash),
								),
								Match.tag("TokenExchangeError", () =>
									HttpServerResponse.text("Authentication failed", {
										status: 400,
									}).pipe(clearStash),
								),
								Match.tag("UserinfoError", () =>
									HttpServerResponse.text(
										"Authentication provider unavailable",
										{ status: 502 },
									).pipe(clearStash),
								),
								Match.tag("IdentityClaimsError", () =>
									HttpServerResponse.text("Authentication failed", {
										status: 400,
									}).pipe(clearStash),
								),
								Match.exhaustive,
							);
						}
						const sessionId = yield* sessions.create(account.right);
						yield* setSessionCookie(sessionId, ttl);
						return yield* HttpServerResponse.text("Success").pipe(clearStash);
					}),
				)
				.handle("logout", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const sessionId = request.cookies[sessionCookieName];
						if (typeof sessionId !== "undefined") {
							yield* sessions.revoke(sessionId);
						}
						yield* setSessionCookie("", 0);
						return HttpServerResponse.empty({ status: 204 });
					}),
				);
		}),
);

const requireAdminTier = Effect.gen(function* () {
	const identity = yield* CurrentIdentity;
	if (!isAdminTier(identity)) {
		return yield* new HttpApiError.Forbidden();
	}
});

const MachinesGroupLive = HttpApiBuilder.group(
	RootApi,
	"Machines",
	(handlers) =>
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			return (
				handlers
					.handle("createApiKey", ({ payload: { displayName } }) =>
						Effect.gen(function* () {
							yield* requireAdminTier;
							return yield* machines.createApiKey({ displayName });
						}),
					)
					.handle("list", () =>
						Effect.gen(function* () {
							yield* requireAdminTier;
							const machineList = yield* machines.list();
							return { machines: machineList };
						}),
					)
					.handle("revoke", ({ path: { id } }) =>
						Effect.gen(function* () {
							yield* requireAdminTier;
							const revoked = yield* machines.revoke(id);
							if (Option.isNone(revoked)) {
								return yield* new HttpApiError.NotFound();
							}
						}),
					)
					.handle("refresh", ({ path: { id } }) =>
						Effect.gen(function* () {
							yield* requireAdminTier;
							const refreshed = yield* machines.refreshApiKey(id);
							if (Option.isNone(refreshed)) {
								return yield* new HttpApiError.NotFound();
							}
							return refreshed.value;
						}),
					)
					// TODO: has to be scoped into namespace
					.handle("grantRole", ({ path: { id }, payload: { role } }) =>
						Effect.gen(function* () {
							yield* requireAdminTier;
							// TODO: use the resolved list of roles in the namespace
							if (isUndeclarableRole(role)) {
								return yield* new HttpApiError.Forbidden();
							}
							const roles = yield* machines.grantRole(id, role);
							if (Option.isNone(roles)) {
								return yield* new HttpApiError.NotFound();
							}
							return { roles: roles.value };
						}),
					)
					.handle("revokeRole", ({ path: { id, role } }) =>
						Effect.gen(function* () {
							yield* requireAdminTier;
							const roles = yield* machines.revokeRole(id, role);
							if (Option.isNone(roles)) {
								return yield* new HttpApiError.NotFound();
							}
							return { roles: roles.value };
						}),
					)
			);
		}),
);

const RolesGroupLive = HttpApiBuilder.group(RootApi, "Roles", (handlers) =>
	Effect.gen(function* () {
		const roleStore = yield* RoleStoreService;

		return handlers
			.handle("grant", ({ payload: { issuer, subject, role } }) =>
				Effect.gen(function* () {
					yield* requireAdminTier;
					const roles = yield* roleStore.grant({ issuer, subject }, role);
					return { roles };
				}),
			)
			.handle("revoke", ({ payload: { issuer, subject, role } }) =>
				Effect.gen(function* () {
					yield* requireAdminTier;
					const roles = yield* roleStore.revoke({ issuer, subject }, role);
					return { roles };
				}),
			);
	}),
);

export const InternalGroupsLive = Layer.mergeAll(
	HttpApiBuilder.group(RootApi, "Field", (handlers) =>
		handlers
			.handle("replicantGet", ({ path: { namespace, fieldName } }) =>
				getReplicant(namespace, fieldName),
			)
			.handle(
				"replicantUpdate",
				({ path: { namespace, fieldName }, payload }) =>
					updateReplicant(namespace, fieldName, payload),
			)
			.handle("computedGet", ({ path: { namespace, fieldName } }) =>
				getComputed(namespace, fieldName),
			)
			.handle("topicPublish", ({ path: { namespace, fieldName }, payload }) =>
				publishTopic(namespace, fieldName, payload),
			)
			.handle("rpcCall", ({ path: { namespace, fieldName }, payload }) =>
				callRpc(namespace, fieldName, payload),
			),
	),
	AuthenticationGroupLive,
	MachinesGroupLive,
	RolesGroupLive,
);
