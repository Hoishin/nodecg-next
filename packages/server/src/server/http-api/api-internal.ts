import { createHash, timingSafeEqual } from "node:crypto";

import {
	ADMIN_TIER,
	type AdminRoleAssignment,
	CurrentIdentity,
	HumanAssignmentSchema,
	isUndeclarableRole,
	MachineAssignmentSchema,
	type RoleAssignmentsDocument,
	RoleImportError,
	sessionCookieName,
	sessionCookieSecurity,
	TooManyRequests,
} from "@nodecg-next/internal";
import { MalformedUrl, parseRelativeUrl } from "@nodecg-next/internal/utils";
import {
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
import { listPermissions } from "../../list-permissions.ts";
import { config } from "../../server-config.ts";
import {
	type MachineClientStore,
	MachineClientStoreService,
} from "../../services/machine-client-store/machine-client-store.ts";
import {
	type RoleStore,
	RoleStoreService,
} from "../../services/role-store/role-store.ts";
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
						Array.from(HashMap.keys(registry)).toSorted(),
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
						if (identity._tag !== "human") {
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
							globalRoles.has("superadmin"),
						);
						if (hasSuperadmin || !tokenEquals(claimToken.value, token)) {
							return yield* new HttpApiError.Forbidden();
						}
						const roles = yield* roleStore.grantGlobal(
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
	{ subject, role }: AdminRoleAssignment,
	humanOp: RoleStore["grantGlobal"] | RoleStore["revokeGlobal"],
	machineOp:
		| MachineClientStore["grantGlobal"]
		| MachineClientStore["revokeGlobal"],
) =>
	Effect.gen(function* () {
		if (subject._tag === "human") {
			const roles = yield* humanOp(
				{ issuer: subject.issuer, subject: subject.subject },
				role,
			);
			return { roles };
		}
		const roles = yield* machineOp(subject.id, role);
		if (Option.isNone(roles)) {
			return yield* new HttpApiError.NotFound();
		}
		return { roles: roles.value };
	});

const AdminRolesGroupLive = HttpApiBuilder.group(
	RootApi,
	"AdminRoles",
	(handlers) =>
		Effect.gen(function* () {
			const roleStore = yield* RoleStoreService;
			const machines = yield* MachineClientStoreService;
			return handlers
				.handle("grantAdmin", ({ payload }) =>
					mutateAdminRole(payload, roleStore.grantGlobal, machines.grantGlobal),
				)
				.handle("revokeAdmin", ({ payload }) =>
					mutateAdminRole(
						payload,
						roleStore.revokeGlobal,
						machines.revokeGlobal,
					),
				);
		}),
);

const assignmentKey = (entry: RoleAssignmentsDocument["assignments"][number]) =>
	Match.value(entry).pipe(
		Match.tag("human", ({ issuer, subject }) => ({
			_tag: "human",
			issuer,
			subject,
		})),
		Match.tag("machine", ({ id }) => ({ _tag: "machine", id })),
		Match.exhaustive,
	);

const MachinesGroupLive = HttpApiBuilder.group(
	RootApi,
	"Machines",
	(handlers) =>
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			return (
				handlers
					.handle("createApiKey", ({ payload: { displayName } }) =>
						machines.createApiKey({ displayName }),
					)
					.handle("list", () =>
						Effect.gen(function* () {
							const machineList = yield* machines.list;
							return { machines: machineList };
						}),
					)
					.handle("revoke", ({ params: { id } }) =>
						Effect.gen(function* () {
							const revoked = yield* machines.revoke(id);
							if (Option.isNone(revoked)) {
								return yield* new HttpApiError.NotFound();
							}
						}),
					)
					.handle("refresh", ({ params: { id } }) =>
						Effect.gen(function* () {
							const refreshed = yield* machines.refreshApiKey(id);
							if (Option.isNone(refreshed)) {
								return yield* new HttpApiError.NotFound();
							}
							return refreshed.value;
						}),
					)
					// TODO: has to be scoped into namespace
					.handle("grantRole", ({ params: { id }, payload: { role } }) =>
						Effect.gen(function* () {
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
					.handle("revokeRole", ({ params: { id, role } }) =>
						Effect.gen(function* () {
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
		const machines = yield* MachineClientStoreService;

		return handlers
			.handle("grant", ({ payload: { issuer, subject, role } }) =>
				Effect.gen(function* () {
					if (isUndeclarableRole(role)) {
						return yield* new HttpApiError.Forbidden();
					}
					const roles = yield* roleStore.grant({ issuer, subject }, role);
					return { roles };
				}),
			)
			.handle("revoke", ({ payload: { issuer, subject, role } }) =>
				Effect.gen(function* () {
					const roles = yield* roleStore.revoke({ issuer, subject }, role);
					return { roles };
				}),
			)
			.handle("export", () =>
				Effect.gen(function* () {
					const humans = yield* roleStore.list;
					const machineClients = yield* machines.list;
					return {
						version: 0,
						assignments: [
							...humans
								.map(({ key, roles, globalRoles }) =>
									HumanAssignmentSchema.make({
										issuer: key.issuer,
										subject: key.subject,
										roles,
										globalRoles: globalRoles.difference(ADMIN_TIER),
									}),
								)
								.filter(
									({ roles, globalRoles }) =>
										roles.size > 0 || globalRoles.size > 0,
								),
							...machineClients
								.map((client) =>
									MachineAssignmentSchema.make({
										id: client.id,
										roles: client.roles,
										globalRoles: client.globalRoles.difference(ADMIN_TIER),
									}),
								)
								.filter(
									({ roles, globalRoles }) =>
										roles.size > 0 || globalRoles.size > 0,
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
							if (isUndeclarableRole(role)) {
								return yield* new RoleImportError({
									message: `role "${role}" cannot be assigned via import (entry ${JSON.stringify(key)})`,
								});
							}
						}
						const [tierRole] = entry.globalRoles.intersection(ADMIN_TIER);
						if (typeof tierRole !== "undefined") {
							return yield* new RoleImportError({
								message: `role "${tierRole}" cannot be assigned via import (entry ${JSON.stringify(key)})`,
							});
						}
					}
					const humanEntries = document.assignments.filter(
						(entry) => entry._tag === "human",
					);
					const machineEntries = document.assignments.filter(
						(entry) => entry._tag === "machine",
					);
					const machineClients = yield* machines.list;
					const machineIds = new Set(machineClients.map((client) => client.id));
					for (const entry of machineEntries) {
						if (!machineIds.has(entry.id)) {
							return yield* new RoleImportError({
								message: `unknown machine id "${entry.id}"`,
							});
						}
					}

					// Admin roles are outside of import and export
					const current = yield* roleStore.list;
					const humanTarget = HashSet.fromIterable(
						humanEntries.map(({ issuer, subject }) => ({ issuer, subject })),
					);

					// Clear roles of users that are not in the import
					if (mode === "replace") {
						for (const assignment of current) {
							if (!HashSet.has(humanTarget, assignment.key)) {
								yield* roleStore.set(assignment.key, new Set());
								yield* roleStore.setGlobal(
									assignment.key,
									assignment.globalRoles.intersection(ADMIN_TIER),
								);
							}
						}
					}

					// Replace or add roles on top of existing roles
					for (const entry of humanEntries) {
						const key = { issuer: entry.issuer, subject: entry.subject };
						const existing = yield* roleStore.get(key);
						yield* roleStore.set(
							key,
							mode === "merge"
								? existing.roles.union(entry.roles)
								: entry.roles,
						);
						yield* roleStore.setGlobal(
							key,
							mode === "merge"
								? existing.globalRoles.union(entry.globalRoles)
								: entry.globalRoles.union(
										existing.globalRoles.intersection(ADMIN_TIER),
									),
						);
					}

					const machineTarget = new Map(
						machineEntries.map((entry) => [entry.id, entry]),
					);
					for (const client of machineClients) {
						const entry = machineTarget.get(client.id);
						if (typeof entry === "undefined") {
							if (mode === "replace") {
								yield* machines.setRoles(client.id, new Set());
								yield* machines.setGlobalRoles(
									client.id,
									client.globalRoles.intersection(ADMIN_TIER),
								);
							}
							continue;
						}
						yield* machines.setRoles(
							client.id,
							mode === "merge" ? client.roles.union(entry.roles) : entry.roles,
						);
						yield* machines.setGlobalRoles(
							client.id,
							mode === "merge"
								? client.globalRoles.union(entry.globalRoles)
								: entry.globalRoles.union(
										client.globalRoles.intersection(ADMIN_TIER),
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
	MachinesGroupLive,
	RolesGroupLive,
	AdminRolesGroupLive,
);
