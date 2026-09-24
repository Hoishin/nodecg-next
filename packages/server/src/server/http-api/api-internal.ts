import { createHash, timingSafeEqual } from "node:crypto";

import {
	ADMIN_TIER,
	type AdminRoleAssignment,
	CurrentIdentity,
	UserAssignmentSchema,
	isUndeclarableRole,
	ServiceAccountAssignmentSchema,
	type RoleAssignmentsDocument,
	RoleImportError,
	sessionCookieName,
	sessionCookieSecurity,
	TooManyRequests,
} from "@nodecg-next/internal";
import { MalformedUrl, parseRelativeUrl } from "@nodecg-next/internal/utils";
import {
	Array,
	Clock,
	type Duration,
	Effect,
	HashMap,
	HashSet,
	Layer,
	Match,
	MutableHashSet,
	Option,
	Redacted,
	Ref,
	Result,
	Semaphore,
} from "effect";
import {
	Cookies,
	HttpServerRequest,
	HttpServerResponse,
	Url,
} from "effect/unstable/http";
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi";

import { AuthProviderRegistry } from "../../auth/auth-provider.ts";
import { FieldRegistryService } from "../../field-registry.ts";
import { listPermissions } from "../../list-permissions.ts";
import { config } from "../../server-config.ts";
import {
	type RoleStore,
	RoleStoreService,
} from "../../services/role-store/role-store.ts";
import {
	type ServiceAccountStore,
	ServiceAccountStoreService,
} from "../../services/service-account-store/service-account-store.ts";
import { SessionStoreService } from "../../services/session-store/session-store.ts";
import { StashStoreService } from "../../services/stash-store/stash-store.ts";
import { RootApi } from "../root-api.ts";
import { UrlPath } from "../url-path.ts";
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
};

// TODO: get this path from Effect HttpApi
const callbackUrl = Effect.fn("callbackUrl")(function* (
	baseUrl: string,
	provider: string,
) {
	const path = yield* UrlPath;
	const url = yield* Effect.fromResult(Url.fromString(baseUrl)).pipe(
		Effect.mapError((error) =>
			MalformedUrl.make({ url: baseUrl, cause: error.cause }),
		),
	);
	return Url.setPathname(
		url,
		path.join(url.pathname, "api/internal/authentication/callback", provider),
	).href;
});

const loginPath = Effect.fn("loginPath")(function* (
	basePath: string,
	provider: string,
) {
	const path = yield* UrlPath;
	return path.join(basePath, "api/internal/authentication/login", provider);
});

const digest = (value: string) => createHash("sha256").update(value).digest();

const tokenEquals = (
	expected: Redacted.Redacted<string>,
	provided: Redacted.Redacted<string>,
) =>
	timingSafeEqual(
		digest(Redacted.value(expected)),
		digest(Redacted.value(provided)),
	);

const CLAIM_ATTEMPT_LIMIT = 5;
const CLAIM_ATTEMPT_WINDOW_MILLIS = 60_000;

const AuthenticationGroupLive = HttpApiBuilder.group(
	RootApi,
	"Authentication",
	(handlers) =>
		Effect.gen(function* () {
			const ttl = yield* config.sessionTtl;
			const baseUrl = yield* config.baseUrl;

			const setStash =
				(value: string, maxAge: Duration.Input) =>
				(response: HttpServerResponse.HttpServerResponse) =>
					response.pipe(
						HttpServerResponse.setCookie(stashCookieName, value, {
							...cookieOptions,
							path: baseUrl.pathname,
							maxAge,
						}),
						// TODO: is this a correct silencing?
						Effect.catchTag(
							"CookiesError",
							() => new HttpApiError.InternalServerError(),
						),
					);
			const clearStash = setStash("", 0);
			const setSessionCookie = (value: string, maxAge: Duration.Input) =>
				HttpApiBuilder.securitySetCookie(sessionCookieSecurity, value, {
					...cookieOptions,
					path: baseUrl.pathname,
					maxAge,
				});

			const registry = yield* AuthProviderRegistry;
			const sessions = yield* SessionStoreService;
			const stashes = yield* StashStoreService;
			const roleStore = yield* RoleStoreService;

			// superadmin claim resources
			const claimToken = yield* config.superadminClaimToken;
			const claimLock = yield* Semaphore.make(1);
			// Rate limiting is global on purpose to avoid attacker to abuse IdP issued tokens
			const claimAttempts = yield* Ref.make<ReadonlyArray<number>>([]);

			return handlers
				.handle("me", () =>
					Effect.gen(function* () {
						const identity = yield* CurrentIdentity;
						return { identity, namespaces: yield* listPermissions(identity) };
					}),
				)
				.handle("providers", () =>
					Effect.forEach(
						Array.fromIterable(HashMap.keys(registry)).toSorted(),
						(name) =>
							loginPath(baseUrl.pathname, name).pipe(
								Effect.map((url) => ({ name, url })),
							),
					),
				)
				.handle("login", ({ params: { provider: name }, query }) =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const provider = HashMap.get(registry, name);
						if (Option.isNone(provider)) {
							return HttpServerResponse.text(
								"Unknown authentication provider",
								{ status: 404 },
							);
						}
						const requestUrl = yield* Effect.fromResult(
							parseRelativeUrl(request.url),
						);
						const redirect = yield* provider.value
							.authorize({
								redirectUri: yield* callbackUrl(baseUrl.href, name),
								searchParams: new URLSearchParams(requestUrl.search),
							})
							.pipe(Effect.result);
						if (Result.isFailure(redirect)) {
							return HttpServerResponse.text(
								"Authentication provider unavailable",
								{ status: 502 },
							);
						}
						const stashId = yield* stashes.create({
							...redirect.success.stash,
							returnTo: query.returnTo,
						});
						return yield* HttpServerResponse.redirect(redirect.success.url, {
							status: 302,
						}).pipe(setStash(stashId, "10 minutes")); // TODO: avoid hard-coded duration
					}),
				)
				.handle("callback", ({ params: { provider: name } }) =>
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
						const requestUrl = yield* Effect.fromResult(
							parseRelativeUrl(request.url),
						);
						const account = yield* provider.value
							.callback({
								redirectUri: yield* callbackUrl(baseUrl.href, name),
								searchParams: new URLSearchParams(requestUrl.search),
								stash: stash.value,
							})
							.pipe(
								Effect.tapError((error) =>
									Effect.logError(
										`Authentication callback failed: ${error.message}`,
									),
								),
								Effect.result,
							);
						if (Result.isFailure(account)) {
							return yield* Match.value(account.failure).pipe(
								Match.tag("ProviderStateMismatch", () =>
									HttpServerResponse.text("OAuth state mismatch", {
										status: 400,
									}).pipe(clearStash),
								),
								Match.tag("ProviderUnavailableError", () =>
									HttpServerResponse.text(
										"Authentication provider unavailable",
										{ status: 502 },
									).pipe(clearStash),
								),
								Match.tag("CredentialExchangeError", () =>
									HttpServerResponse.text("Authentication failed", {
										status: 400,
									}).pipe(clearStash),
								),
								Match.tag("ProviderResponseError", () =>
									HttpServerResponse.text(
										"Authentication provider unavailable",
										{ status: 502 },
									).pipe(clearStash),
								),
								Match.tag("NoIdentity", () =>
									HttpServerResponse.text("Authentication failed", {
										status: 400,
									}).pipe(clearStash),
								),
								Match.exhaustive,
							);
						}
						const sessionId = yield* sessions.create(account.success);
						yield* setSessionCookie(sessionId, ttl);
						const returnTo = stash.value.returnTo;
						return yield* (
							typeof returnTo === "undefined"
								? HttpServerResponse.text("Success")
								: HttpServerResponse.redirect(returnTo, { status: 302 })
						).pipe(clearStash);
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
				)
				.handle("claimSuperadmin", ({ payload: { token } }) =>
					Effect.gen(function* () {
						const identity = yield* CurrentIdentity;
						// Gate unauthenticated users to consume rate limit
						if (identity._tag !== "user") {
							return yield* new HttpApiError.Forbidden();
						}

						const now = yield* Clock.currentTimeMillis;
						const recent = (yield* Ref.get(claimAttempts)).filter(
							(at) => now - at < CLAIM_ATTEMPT_WINDOW_MILLIS,
						);
						if (recent.length >= CLAIM_ATTEMPT_LIMIT) {
							return yield* new TooManyRequests();
						}
						yield* Ref.set(claimAttempts, [...recent, now]);

						if (Option.isNone(claimToken)) {
							return yield* new HttpApiError.Forbidden();
						}
						const assignments = yield* roleStore.list;
						const hasSuperadmin = assignments.some(({ globalRoles }) =>
							globalRoles.includes("superadmin"),
						);
						if (hasSuperadmin || !tokenEquals(claimToken.value, token)) {
							return yield* new HttpApiError.Forbidden();
						}
						const roles = yield* roleStore.grantGlobalRole(
							{
								issuer: identity.account.issuer,
								subject: identity.account.subject,
							},
							"superadmin",
						);
						return { roles };
					}).pipe(claimLock.withPermits(1)),
				);
		}),
);

const mutateAdminRole = (
	{ target, role }: AdminRoleAssignment,
	userOp: RoleStore["grantGlobalRole"] | RoleStore["revokeGlobalRole"],
	serviceAccountOp:
		| ServiceAccountStore["grantGlobalRole"]
		| ServiceAccountStore["revokeGlobalRole"],
) =>
	Match.value(target).pipe(
		Match.tag("user", ({ login }) =>
			Effect.gen(function* () {
				const roles = yield* userOp(login, role);
				return { roles };
			}),
		),
		Match.tag("serviceAccount", ({ id }) =>
			Effect.gen(function* () {
				const roles = yield* serviceAccountOp(id, role);
				if (Option.isNone(roles)) {
					return yield* new HttpApiError.NotFound();
				}
				return { roles: roles.value };
			}),
		),
		Match.exhaustive,
	);

const AdminRolesGroupLive = HttpApiBuilder.group(
	RootApi,
	"AdminRoles",
	(handlers) =>
		Effect.gen(function* () {
			const roleStore = yield* RoleStoreService;
			const serviceAccounts = yield* ServiceAccountStoreService;
			return handlers
				.handle("grantAdmin", ({ payload }) =>
					mutateAdminRole(
						payload,
						roleStore.grantGlobalRole,
						serviceAccounts.grantGlobalRole,
					),
				)
				.handle("revokeAdmin", ({ payload }) =>
					mutateAdminRole(
						payload,
						roleStore.revokeGlobalRole,
						serviceAccounts.revokeGlobalRole,
					),
				);
		}),
);

const assignmentKey = (entry: RoleAssignmentsDocument["assignments"][number]) =>
	Match.value(entry).pipe(
		Match.tag("user", ({ login }) => ({ _tag: "user", login })),
		Match.tag("serviceAccount", ({ id }) => ({ _tag: "serviceAccount", id })),
		Match.exhaustive,
	);

const ServiceAccountsGroupLive = HttpApiBuilder.group(
	RootApi,
	"ServiceAccounts",
	(handlers) =>
		Effect.gen(function* () {
			const serviceAccounts = yield* ServiceAccountStoreService;
			return handlers
				.handle("createApiKey", ({ payload: { displayName } }) =>
					serviceAccounts.createApiKey({ displayName }),
				)
				.handle("list", () =>
					Effect.gen(function* () {
						const serviceAccountList = yield* serviceAccounts.list;
						return { serviceAccounts: serviceAccountList };
					}),
				)
				.handle("revoke", ({ params: { id } }) =>
					Effect.gen(function* () {
						const revoked = yield* serviceAccounts.revoke(id);
						if (Option.isNone(revoked)) {
							return yield* new HttpApiError.NotFound();
						}
					}),
				)
				.handle("refresh", ({ params: { id } }) =>
					Effect.gen(function* () {
						const refreshed = yield* serviceAccounts.refreshApiKey(id);
						if (Option.isNone(refreshed)) {
							return yield* new HttpApiError.NotFound();
						}
						return refreshed.value;
					}),
				)
				.handle("grantRole", ({ params: { id }, payload: role }) =>
					Effect.gen(function* () {
						const { declaredRoles } = yield* FieldRegistryService;
						if (!declaredRoles.get(role.namespace)?.has(role.name)) {
							return yield* new HttpApiError.Forbidden();
						}
						const roles = yield* serviceAccounts.grantRole(id, role);
						if (Option.isNone(roles)) {
							return yield* new HttpApiError.NotFound();
						}
						return { roles: roles.value };
					}),
				)
				.handle("revokeRole", ({ params: { id, namespace, name } }) =>
					Effect.gen(function* () {
						const roles = yield* serviceAccounts.revokeRole(id, {
							namespace,
							name,
						});
						if (Option.isNone(roles)) {
							return yield* new HttpApiError.NotFound();
						}
						return { roles: roles.value };
					}),
				);
		}),
);

const RolesGroupLive = HttpApiBuilder.group(RootApi, "Roles", (handlers) =>
	Effect.gen(function* () {
		const roleStore = yield* RoleStoreService;
		const serviceAccounts = yield* ServiceAccountStoreService;

		return handlers
			.handle("grant", ({ payload: { login, role } }) =>
				Effect.gen(function* () {
					const { declaredRoles } = yield* FieldRegistryService;
					if (!declaredRoles.get(role.namespace)?.has(role.name)) {
						return yield* new HttpApiError.Forbidden();
					}
					const roles = yield* roleStore.grantRole(login, role);
					return { roles };
				}),
			)
			.handle("revoke", ({ payload: { login, role } }) =>
				Effect.gen(function* () {
					const roles = yield* roleStore.revokeRole(login, role);
					return { roles };
				}),
			)
			.handle("export", () =>
				Effect.gen(function* () {
					const users = yield* roleStore.list;
					const serviceAccountList = yield* serviceAccounts.list;
					return {
						version: 0,
						assignments: [
							...users
								.map(({ key, roles, globalRoles }) =>
									UserAssignmentSchema.make({
										login: key,
										roles,
										globalRoles: Array.difference(globalRoles, ADMIN_TIER),
									}),
								)
								.filter(
									({ roles, globalRoles }) =>
										roles.length > 0 || globalRoles.length > 0,
								),
							...serviceAccountList
								.map((client) =>
									ServiceAccountAssignmentSchema.make({
										id: client.id,
										roles: client.roles,
										globalRoles: Array.difference(
											client.globalRoles,
											ADMIN_TIER,
										),
									}),
								)
								.filter(
									({ roles, globalRoles }) =>
										roles.length > 0 || globalRoles.length > 0,
								),
						],
					};
				}),
			)
			.handle("import", ({ payload: { mode, document } }) =>
				// TODO: role store needs to support abstracted transaction interface (platform agnostic)
				Effect.gen(function* () {
					const seen = MutableHashSet.empty<ReturnType<typeof assignmentKey>>();
					for (const entry of document.assignments) {
						const key = assignmentKey(entry);
						if (MutableHashSet.has(seen, key)) {
							return yield* new RoleImportError({
								message: `duplicate assignment entry for ${JSON.stringify(key)}`,
							});
						}
						MutableHashSet.add(seen, key);
						for (const role of entry.roles) {
							if (isUndeclarableRole(role.name)) {
								return yield* new RoleImportError({
									message: `role "${role.name}" cannot be assigned via import (entry ${JSON.stringify(key)})`,
								});
							}
						}
						const [tierRole] = Array.intersection(
							entry.globalRoles,
							ADMIN_TIER,
						);
						if (typeof tierRole !== "undefined") {
							return yield* new RoleImportError({
								message: `role "${tierRole}" cannot be assigned via import (entry ${JSON.stringify(key)})`,
							});
						}
					}
					const userEntries = document.assignments.filter(
						(entry) => entry._tag === "user",
					);
					const serviceAccountEntries = document.assignments.filter(
						(entry) => entry._tag === "serviceAccount",
					);
					const serviceAccountList = yield* serviceAccounts.list;
					const serviceAccountIds = new Set(
						serviceAccountList.map((client) => client.id),
					);
					for (const entry of serviceAccountEntries) {
						if (!serviceAccountIds.has(entry.id)) {
							return yield* new RoleImportError({
								message: `unknown service account id "${entry.id}"`,
							});
						}
					}

					// Admin roles are outside of import and export
					const current = yield* roleStore.list;
					const userTarget = HashSet.fromIterable(
						userEntries.map(({ login }) => login),
					);

					// Clear roles of users that are not in the import
					if (mode === "replace") {
						for (const assignment of current) {
							if (!HashSet.has(userTarget, assignment.key)) {
								yield* roleStore.setRoles(assignment.key, []);
								yield* roleStore.setGlobalRoles(
									assignment.key,
									Array.intersection(assignment.globalRoles, ADMIN_TIER),
								);
							}
						}
					}

					// Replace or add roles on top of existing roles
					for (const entry of userEntries) {
						const existing = yield* roleStore.get(entry.login);
						yield* roleStore.setRoles(
							entry.login,
							mode === "merge"
								? Array.union(existing.roles, entry.roles)
								: entry.roles,
						);
						yield* roleStore.setGlobalRoles(
							entry.login,
							mode === "merge"
								? Array.union(existing.globalRoles, entry.globalRoles)
								: Array.union(
										entry.globalRoles,
										Array.intersection(existing.globalRoles, ADMIN_TIER),
									),
						);
					}

					const serviceAccountTarget = new Map(
						serviceAccountEntries.map((entry) => [entry.id, entry]),
					);
					for (const client of serviceAccountList) {
						const entry = serviceAccountTarget.get(client.id);
						if (typeof entry === "undefined") {
							if (mode === "replace") {
								yield* serviceAccounts.setRoles(client.id, []);
								yield* serviceAccounts.setGlobalRoles(
									client.id,
									Array.intersection(client.globalRoles, ADMIN_TIER),
								);
							}
							continue;
						}
						yield* serviceAccounts.setRoles(
							client.id,
							mode === "merge"
								? Array.union(client.roles, entry.roles)
								: entry.roles,
						);
						yield* serviceAccounts.setGlobalRoles(
							client.id,
							mode === "merge"
								? Array.union(client.globalRoles, entry.globalRoles)
								: Array.union(
										entry.globalRoles,
										Array.intersection(client.globalRoles, ADMIN_TIER),
									),
						);
					}
				}),
			);
	}),
);

export const InternalGroupsLive = Layer.mergeAll(
	HttpApiBuilder.group(RootApi, "Field", (handlers) =>
		handlers
			.handle("replicantGet", ({ params: { namespace, fieldName } }) =>
				getReplicant(namespace, fieldName),
			)
			.handle(
				"replicantUpdate",
				({ params: { namespace, fieldName }, payload }) =>
					updateReplicant(namespace, fieldName, payload),
			)
			.handle("computedGet", ({ params: { namespace, fieldName } }) =>
				getComputed(namespace, fieldName),
			)
			.handle("topicPublish", ({ params: { namespace, fieldName }, payload }) =>
				publishTopic(namespace, fieldName, payload),
			)
			.handle("rpcCall", ({ params: { namespace, fieldName }, payload }) =>
				callRpc(namespace, fieldName, payload),
			),
	),
	AuthenticationGroupLive,
	ServiceAccountsGroupLive,
	RolesGroupLive,
	AdminRolesGroupLive,
);
