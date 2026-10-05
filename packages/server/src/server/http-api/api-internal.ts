import { timingSafeEqual } from "node:crypto";

import {
	CurrentIdentity,
	UserAssignmentSchema,
	PermissionDenied,
	ServiceAccountAssignmentSchema,
	RoleAssignmentsDocument,
	sessionCookieName,
	TooManyRequests,
	AccountId,
	Role,
} from "@nodecg-next/internal";
import { MalformedUrl, parseRelativeUrl } from "@nodecg-next/internal/utils";
import {
	Array,
	Clock,
	type Config,
	Crypto,
	type Duration,
	Effect,
	HashMap,
	HashSet,
	Layer,
	Match,
	MutableHashMap,
	Option,
	type PlatformError,
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
	revokeRole,
} from "../../auth/roles.ts";
import {
	createServiceAccount,
	hashApiKey,
	newApiKey,
} from "../../auth/service-accounts.ts";
import {
	cookieOptions,
	createSession,
	revokeSession,
	setSessionCookie,
} from "../../auth/session.ts";
import { ConfiguredSuperadmins } from "../../configured-superadmins.ts";
import { FieldRegistryService } from "../../field-registry.ts";
import { listPermissions } from "../../list-permissions.ts";
import { config } from "../../server-config.ts";
import { AccountRepositoryService } from "../../services/repository/account/account-repository.ts";
import { AuthenticationRepositoryService } from "../../services/repository/authentication/authentication-repository.ts";
import type { BackendError } from "../../services/repository/repository-errors.ts";
import { RoleRepositoryService } from "../../services/repository/role/role-repository.ts";
import { ServiceAccountRepositoryService } from "../../services/repository/service-account/service-account-repository.ts";
import { UserRepositoryService } from "../../services/repository/user/user-repository.ts";
import { TransactionService } from "../../services/transaction/transaction.ts";
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

const tokenEquals = Effect.fnUntraced(function* (
	expected: Redacted.Redacted<string>,
	provided: Redacted.Redacted<string>,
) {
	const crypto = yield* Crypto.Crypto;
	const encoder = new TextEncoder();
	const expectedDigest = yield* crypto.digest(
		"SHA-256",
		encoder.encode(Redacted.value(expected)),
	);
	const providedDigest = yield* crypto.digest(
		"SHA-256",
		encoder.encode(Redacted.value(provided)),
	);
	return timingSafeEqual(expectedDigest, providedDigest);
});

const CLAIM_ATTEMPT_LIMIT = 5;
const CLAIM_ATTEMPT_WINDOW_MILLIS = 60_000;

const reportBackendFailure = <A, E, R>(
	effect: Effect.Effect<
		A,
		E | BackendError | Config.ConfigError | PlatformError.PlatformError,
		R
	>,
) =>
	effect.pipe(
		Effect.tapDefect((defect) => Effect.logError("Backend failed", defect)),
		Effect.catchTag(["BackendError", "ConfigError", "PlatformError"], (error) =>
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
								Effect.catchTag(["BackendError", "PlatformError"], () =>
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
						const authentication = yield* Match.value(identity).pipe(
							Match.tag("user", (user) => Effect.succeed(user.authentication)),
							Match.tag("serviceAccount", "server", () =>
								HttpApiError.Forbidden.make(),
							),
							Match.tag("anonymous", () => HttpApiError.Unauthorized.make()),
							Match.exhaustive,
						);

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
							!(yield* tokenEquals(claimToken.value, token))
						) {
							return yield* new HttpApiError.Forbidden();
						}
						yield* grantGlobalRole(authentication, "superadmin");
					}).pipe(
						Effect.catchTag(["UnknownAuthentication", "UnknownAccount"], () =>
							HttpApiError.Forbidden.make(),
						),
						reportBackendFailure,
						claimLock.withPermits(1),
					),
				);
		}),
);

const AdminRolesGroupLive = HttpApiBuilder.group(
	RootApi,
	"AdminRoles",
	(handlers) =>
		handlers
			.handle("grantAdmin", ({ payload: { accountId, role } }) =>
				Effect.gen(function* () {
					const roleRepository = yield* RoleRepositoryService;
					yield* roleRepository.grantGlobalRole(accountId, role);
				}).pipe(
					Effect.catchTag("UnknownAccount", () => HttpApiError.NotFound.make()),
					reportBackendFailure,
				),
			)
			.handle("revokeAdmin", ({ payload: { accountId, role } }) =>
				revokeGlobalRole(accountId, role).pipe(
					Effect.catchTags({
						UnknownAccount: () => HttpApiError.NotFound.make(),
						SuperadminInConfig: () =>
							PermissionDenied.make({
								message:
									"This superadmin comes from NODECG_SUPERADMINS and can only be revoked by removing the entry there",
							}),
					}),
					reportBackendFailure,
				),
			),
);

const UsersGroupLive = HttpApiBuilder.group(RootApi, "Users", (handlers) =>
	handlers.handle("list", () =>
		Effect.gen(function* () {
			const userRepository = yield* UserRepositoryService;
			const superadmins = yield* ConfiguredSuperadmins;
			const users = yield* userRepository.listAll();
			return {
				users: users.map(
					({
						id,
						accountId,
						displayName,
						authentications,
						roles,
						globalRoles,
					}) => ({
						id,
						accountId,
						displayName,
						authentications,
						roles,
						globalRoles: authentications.some((authentication) =>
							Array.contains(superadmins, authentication),
						)
							? Array.union(globalRoles, ["superadmin"] as const)
							: globalRoles,
					}),
				),
			};
		}).pipe(reportBackendFailure),
	),
);

const ServiceAccountsGroupLive = HttpApiBuilder.group(
	RootApi,
	"ServiceAccounts",
	(handlers) =>
		handlers
			.handle("createApiKey", ({ payload: { displayName } }) =>
				Effect.gen(function* () {
					const creator = yield* CurrentIdentity;
					return yield* createServiceAccount(displayName, creator);
				}).pipe(
					Effect.catchTags({
						NotAUser: () => HttpApiError.Forbidden.make(),
						ServerCreatorNotImplemented: () =>
							HttpApiError.NotImplemented.make(),
					}),
					reportBackendFailure,
				),
			)
			.handle("list", () =>
				Effect.gen(function* () {
					const serviceAccounts = yield* ServiceAccountRepositoryService;
					return { serviceAccounts: yield* serviceAccounts.listAll() };
				}).pipe(reportBackendFailure),
			)
			.handle("revoke", ({ params: { id } }) =>
				Effect.gen(function* () {
					const serviceAccounts = yield* ServiceAccountRepositoryService;
					const found = yield* serviceAccounts.delete(id);
					if (!found) {
						return yield* HttpApiError.NotFound.make();
					}
				}).pipe(reportBackendFailure),
			)
			.handle("refresh", ({ params: { id } }) =>
				Effect.gen(function* () {
					const serviceAccounts = yield* ServiceAccountRepositoryService;
					const token = yield* newApiKey();
					const hash = yield* hashApiKey(Redacted.value(token));
					const replaced = yield* serviceAccounts.replaceKey(id, {
						hash,
						label: "",
					});
					if (Option.isNone(replaced)) {
						return yield* HttpApiError.NotFound.make();
					}
					return {
						serviceAccountId: id,
						accountId: replaced.value.accountId,
						displayName: replaced.value.displayName,
						token,
					};
				}).pipe(reportBackendFailure),
			)
			.handle("grantRole", ({ params: { id }, payload: role }) =>
				Effect.gen(function* () {
					const { declaredRoles } = yield* FieldRegistryService;
					if (!declaredRoles.get(role.namespace)?.has(role.name)) {
						return yield* HttpApiError.UnprocessableEntity.make();
					}
					const serviceAccounts = yield* ServiceAccountRepositoryService;
					const found = yield* serviceAccounts.grantRole(id, role);
					if (!found) {
						return yield* HttpApiError.NotFound.make();
					}
				}).pipe(reportBackendFailure),
			)
			.handle("revokeRole", ({ params: { id, namespace, name } }) =>
				Effect.gen(function* () {
					const serviceAccounts = yield* ServiceAccountRepositoryService;
					const found = yield* serviceAccounts.revokeRole(id, {
						namespace,
						name,
					});
					if (!found) {
						return yield* HttpApiError.NotFound.make();
					}
				}).pipe(reportBackendFailure),
			),
);

const RolesGroupLive = HttpApiBuilder.group(RootApi, "Roles", (handlers) =>
	handlers
		.handle("grant", ({ payload: { authentication, role } }) =>
			Effect.gen(function* () {
				const { declaredRoles } = yield* FieldRegistryService;
				if (!declaredRoles.get(role.namespace)?.has(role.name)) {
					return yield* HttpApiError.UnprocessableEntity.make();
				}
				yield* grantRole(authentication, role);
			}).pipe(
				Effect.catchTag("UnknownAuthentication", () =>
					HttpApiError.NotFound.make(),
				),
				reportBackendFailure,
			),
		)
		.handle("revoke", ({ payload: { authentication, role } }) =>
			revokeRole(authentication, role).pipe(
				Effect.catchTag("UnknownAuthentication", () =>
					HttpApiError.NotFound.make(),
				),
				reportBackendFailure,
			),
		)
		.handle("export", () =>
			Effect.gen(function* () {
				const roleRepository = yield* RoleRepositoryService;
				const users = yield* roleRepository.listAll();
				const serviceAccounts = yield* ServiceAccountRepositoryService;
				const serviceAccountList = yield* serviceAccounts.listAll();
				return RoleAssignmentsDocument.make({
					version: 0,
					assignments: [
						...users
							.map(({ authentication, displayName, roles }) =>
								UserAssignmentSchema.make({
									authentication,
									displayName,
									roles,
									globalRoles: [],
								}),
							)
							.filter(({ roles }) => roles.length > 0),
						...serviceAccountList
							.map((client) =>
								ServiceAccountAssignmentSchema.make({
									id: client.id,
									roles: client.roles,
									globalRoles: [],
								}),
							)
							.filter(({ roles }) => roles.length > 0),
					],
				});
			}).pipe(reportBackendFailure),
		)
		.handle("import", ({ payload: { mode, document } }) =>
			Effect.gen(function* () {
				const accounts = yield* AccountRepositoryService;
				const authentications = yield* AuthenticationRepositoryService;
				const serviceAccounts = yield* ServiceAccountRepositoryService;

				const accountRoleMap = MutableHashMap.empty<
					AccountId,
					HashSet.HashSet<Role>
				>();

				// Admin roles are outside of import and export
				const roleRepository = yield* RoleRepositoryService;
				yield* TransactionService.wrap(
					Effect.gen(function* () {
						for (const entry of document.assignments) {
							const accountId = yield* Match.value(entry).pipe(
								Match.tag("user", ({ authentication, displayName }) =>
									Effect.gen(function* () {
										const accountId =
											yield* accounts.resolveByAuthentication(authentication);
										if (Option.isSome(accountId)) {
											return accountId.value;
										}
										const upsertResult =
											yield* authentications.findOrCreateAuthentication(
												authentication,
												displayName,
											);
										return upsertResult.accountId;
									}),
								),
								Match.tag("serviceAccount", ({ id }) =>
									Effect.gen(function* () {
										const account = yield* serviceAccounts.resolveById(id);
										if (Option.isSome(account)) {
											return account.value.accountId;
										}
										const creatorIdentity = yield* CurrentIdentity;
										if (creatorIdentity._tag !== "user") {
											return yield* HttpApiError.Forbidden.make();
										}
										const creatorAccountId =
											yield* accounts.resolveByAuthentication(
												creatorIdentity.authentication,
											);
										if (Option.isNone(creatorAccountId)) {
											return yield* HttpApiError.Forbidden.make();
										}
										const { accountId } = yield* serviceAccounts.createWithId({
											id,
											displayName: "", // TODO: import display name from the document
											createdBy: creatorAccountId.value,
										});
										return accountId;
									}),
								),
								Match.exhaustive,
							);
							MutableHashMap.modifyAt(accountRoleMap, accountId, (existing) =>
								existing.pipe(
									Option.getOrElse(() => HashSet.empty<Role>()),
									HashSet.union(HashSet.fromIterable(entry.roles)),
									Option.some,
								),
							);
						}

						if (mode === "replace") {
							yield* roleRepository.revokeAllRoles();
						}
						yield* roleRepository.grantRoles(
							HashMap.fromIterable(accountRoleMap),
						);
					}),
				);
			}).pipe(reportBackendFailure),
		),
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
	UsersGroupLive,
	RolesGroupLive,
	AdminRolesGroupLive,
);
