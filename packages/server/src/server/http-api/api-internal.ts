import { createHash, timingSafeEqual } from "node:crypto";

import {
	ADMIN_TIER,
	type AdminRoleAssignment,
	CurrentIdentity,
	UserAssignmentSchema,
	isUndeclarableRole,
	PermissionDenied,
	ServiceAccountAssignmentSchema,
	type RoleAssignmentsDocument,
	RoleImportError,
	sessionCookieName,
	TooManyRequests,
} from "@nodecg-next/internal";
import { MalformedUrl, parseRelativeUrl } from "@nodecg-next/internal/utils";
import {
	Array,
	Clock,
	type Config,
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
	HttpServerRequest,
	HttpServerResponse,
	Url,
} from "effect/unstable/http";
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi";

import { AuthProviderRegistry } from "../../auth/auth-provider.ts";
import {
	consumeLoginAttempt,
	createLoginAttempt,
} from "../../auth/login-attempt.ts";
import {
	grantGlobalRole,
	grantRole,
	superadminExists,
	revokeGlobalRole,
} from "../../auth/roles.ts";
import {
	cookieOptions,
	createSession,
	revokeSession,
	setSessionCookie,
} from "../../auth/session.ts";
import { FieldRegistryService } from "../../field-registry.ts";
import { listPermissions } from "../../list-permissions.ts";
import { config } from "../../server-config.ts";
import type { BackendError } from "../../services/repository/repository-errors.ts";
import { RoleStoreService } from "../../services/role-store/role-store.ts";
import { ServiceAccountStoreService } from "../../services/service-account-store/service-account-store.ts";
import { RootApi } from "../root-api.ts";
import { UrlPath } from "../url-path.ts";
import {
	callRpc,
	getComputed,
	getReplicant,
	publishTopic,
	updateReplicant,
} from "./shared.ts";

const loginAttemptCookieName = "nodecg.login_attempt";

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

const reportBackendFailure = <A, E, R>(
	effect: Effect.Effect<A, E | BackendError | Config.ConfigError, R>,
) =>
	effect.pipe(
		Effect.tapDefect((defect) => Effect.logError("Backend failed", defect)),
		Effect.catchTag(["BackendError", "ConfigError"], (error) =>
			Effect.logError("Backend failed", error).pipe(
				Effect.andThen(HttpApiError.InternalServerError.make()),
			),
		),
	);

const AuthenticationGroupLive = HttpApiBuilder.group(
	RootApi,
	"Authentication",
	(handlers) =>
		Effect.gen(function* () {
			const baseUrl = yield* config.baseUrl;
			const loginAttemptTtl = yield* config.loginAttemptTtl;
			const sessionTtl = yield* config.sessionTtl;

			const setLoginAttemptCookie =
				(value: string, maxAge: Duration.Input) =>
				(response: HttpServerResponse.HttpServerResponse) =>
					response.pipe(
						HttpServerResponse.setCookie(loginAttemptCookieName, value, {
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
			const clearLoginAttemptCookie = setLoginAttemptCookie("", 0);

			const registry = yield* AuthProviderRegistry;
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
						const authorized = redirect.success.loginAttempt;
						const key = yield* createLoginAttempt({
							provider: authorized.provider,
							state: authorized.state,
							codeVerifier: authorized.codeVerifier,
							nonce: authorized.nonce,
							returnTo: query.returnTo,
						}).pipe(reportBackendFailure);
						return yield* HttpServerResponse.redirect(redirect.success.url, {
							status: 302,
						}).pipe(setLoginAttemptCookie(key, loginAttemptTtl));
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
						const loginAttemptKey = request.cookies[loginAttemptCookieName];
						if (typeof loginAttemptKey === "undefined") {
							return yield* HttpServerResponse.text(
								"Invalid or missing login state",
								{ status: 400 },
							).pipe(clearLoginAttemptCookie);
						}
						const loginAttempt =
							yield* consumeLoginAttempt(loginAttemptKey).pipe(
								reportBackendFailure,
							);
						if (Option.isNone(loginAttempt)) {
							return yield* HttpServerResponse.text(
								"Invalid or missing login state",
								{ status: 400 },
							).pipe(clearLoginAttemptCookie);
						}
						const requestUrl = yield* Effect.fromResult(
							parseRelativeUrl(request.url),
						);
						const authenticated = yield* provider.value
							.callback({
								redirectUri: yield* callbackUrl(baseUrl.href, name),
								searchParams: new URLSearchParams(requestUrl.search),
								loginAttempt: loginAttempt.value,
							})
							.pipe(
								Effect.tapCause((cause) =>
									Effect.logError("Authentication callback failed", cause),
								),
								Effect.result,
							);
						if (Result.isFailure(authenticated)) {
							return yield* Match.value(authenticated.failure).pipe(
								Match.tag("ProviderStateMismatch", () =>
									HttpServerResponse.text("OAuth state mismatch", {
										status: 400,
									}).pipe(clearLoginAttemptCookie),
								),
								Match.tag("ProviderUnavailableError", () =>
									HttpServerResponse.text(
										"Authentication provider unavailable",
										{ status: 502 },
									).pipe(clearLoginAttemptCookie),
								),
								Match.tag("CredentialExchangeError", () =>
									HttpServerResponse.text("Authentication failed", {
										status: 400,
									}).pipe(clearLoginAttemptCookie),
								),
								Match.tag("ProviderResponseError", () =>
									HttpServerResponse.text(
										"Authentication provider unavailable",
										{ status: 502 },
									).pipe(clearLoginAttemptCookie),
								),
								Match.tag("NoIdentity", () =>
									HttpServerResponse.text("Authentication failed", {
										status: 400,
									}).pipe(clearLoginAttemptCookie),
								),
								Match.exhaustive,
							);
						}
						const token = yield* createSession(
							authenticated.success.authentication,
							authenticated.success.displayName,
						).pipe(reportBackendFailure);
						yield* setSessionCookie(token, {
							path: baseUrl.pathname,
							maxAge: sessionTtl,
						});
						const returnTo = loginAttempt.value.returnTo;
						return yield* (
							typeof returnTo === "undefined"
								? HttpServerResponse.text("Success")
								: HttpServerResponse.redirect(returnTo, { status: 302 })
						).pipe(clearLoginAttemptCookie);
					}),
				)
				.handle("logout", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const token = request.cookies[sessionCookieName];
						if (typeof token !== "undefined") {
							yield* revokeSession(token).pipe(
								Effect.tapCause((cause) =>
									Effect.logError("Logout failed", cause),
								),
								Effect.catchTag("BackendError", () =>
									HttpApiError.InternalServerError.make(),
								),
							);
						}
						yield* setSessionCookie("", { path: baseUrl.pathname, maxAge: 0 });
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
						if (
							(yield* superadminExists()) ||
							!tokenEquals(claimToken.value, token)
						) {
							return yield* new HttpApiError.Forbidden();
						}
						const roles = yield* roleStore.grantGlobalRole(
							identity.authentication,
							"superadmin",
						);
						return { roles };
					}).pipe(claimLock.withPermits(1)),
				);
		}),
);

const mutateAdminRole = (
	{ target, role }: AdminRoleAssignment,
	action: "grant" | "revoke",
) =>
	Match.value(target).pipe(
		Match.tag("user", ({ authentication }) =>
			Effect.gen(function* () {
				const roles = yield* Match.value(action).pipe(
					Match.when("grant", () => grantGlobalRole(authentication, role)),
					Match.when("revoke", () => revokeGlobalRole(authentication, role)),
					Match.exhaustive,
				);
				return { roles };
			}).pipe(
				Effect.catchTags({
					UnknownAuthentication: () => HttpApiError.NotFound.make(),
					SuperadminInConfig: () =>
						PermissionDenied.make({
							message:
								"This superadmin comes from NODECG_SUPERADMINS and can only be revoked by removing the entry there",
						}),
				}),
				reportBackendFailure,
			),
		),
		Match.tag("serviceAccount", ({ id }) =>
			Effect.gen(function* () {
				const serviceAccounts = yield* ServiceAccountStoreService;
				const roles = yield* Match.value(action).pipe(
					Match.when("grant", () => serviceAccounts.grantGlobalRole(id, role)),
					Match.when("revoke", () =>
						serviceAccounts.revokeGlobalRole(id, role),
					),
					Match.exhaustive,
				);
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
		handlers
			.handle("grantAdmin", ({ payload }) => mutateAdminRole(payload, "grant"))
			.handle("revokeAdmin", ({ payload }) =>
				mutateAdminRole(payload, "revoke"),
			),
);

const assignmentKey = (entry: RoleAssignmentsDocument["assignments"][number]) =>
	Match.value(entry).pipe(
		Match.tag("user", ({ authentication }) => ({
			_tag: "user",
			authentication,
		})),
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
			.handle("grant", ({ payload: { authentication, role } }) =>
				Effect.gen(function* () {
					const { declaredRoles } = yield* FieldRegistryService;
					if (!declaredRoles.get(role.namespace)?.has(role.name)) {
						return yield* new HttpApiError.Forbidden();
					}
					const roles = yield* grantRole(authentication, role);
					return { roles };
				}).pipe(
					Effect.catchTag("UnknownAuthentication", () =>
						HttpApiError.NotFound.make(),
					),
					reportBackendFailure,
				),
			)
			.handle("revoke", ({ payload: { authentication, role } }) =>
				Effect.gen(function* () {
					const roles = yield* roleStore.revokeRole(authentication, role);
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
										authentication: key,
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
						userEntries.map(({ authentication }) => authentication),
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
						const existing = yield* roleStore.get(entry.authentication);
						yield* roleStore.setRoles(
							entry.authentication,
							mode === "merge"
								? Array.union(existing.roles, entry.roles)
								: entry.roles,
						);
						yield* roleStore.setGlobalRoles(
							entry.authentication,
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
