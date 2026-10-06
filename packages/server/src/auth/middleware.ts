import { isAdminTier, isSuperadmin } from "@nodecg-next/core";
import {
	AdminTierMiddleware,
	CurrentIdentity,
	CurrentSessionCaller,
	CurrentUser,
	UserAuthenticationMiddleware,
	ServiceAccountAuthenticationMiddleware,
	SuperadminMiddleware,
} from "@nodecg-next/internal";
import { type Crypto, Effect, Layer, Option, Redacted } from "effect";
import { HttpApiError } from "effect/unstable/httpapi";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { config } from "../server-config.ts";
import { RoleRepositoryService } from "../services/repository/role/role-repository.ts";
import { ServiceAccountRepositoryService } from "../services/repository/service-account/service-account-repository.ts";
import { SessionRepositoryService } from "../services/repository/session/session-repository.ts";
import {
	anonymousIdentity,
	resolveServiceAccountIdentity,
	resolveSessionCaller,
} from "./identity.ts";
import { renewSession, setSessionCookie } from "./session.ts";

export const UserAuthenticationMiddlewareLive = Layer.effect(
	UserAuthenticationMiddleware,
	Effect.gen(function* () {
		const requireAuth = yield* config.requireAuth;
		const baseUrl = yield* config.baseUrl;
		const sessionTtl = yield* config.sessionTtl;
		const context = yield* Effect.context<
			SessionRepositoryService | ConfiguredSuperadmins | Crypto.Crypto
		>();
		const resolve = (token: string) =>
			resolveSessionCaller(token).pipe(
				Effect.provide(context),
				Effect.tapCause((cause) =>
					Effect.logError("Session lookup failed", cause),
				),
				Effect.catchTag(["BackendError", "PlatformError"], () =>
					HttpApiError.InternalServerError.make(),
				),
			);
		const renew = (token: string) =>
			renewSession(token).pipe(
				Effect.provide(context),
				Effect.tapCause((cause) =>
					Effect.logError("Session renewal failed", cause),
				),
				Effect.catchTag(["BackendError", "ConfigError", "PlatformError"], () =>
					HttpApiError.InternalServerError.make(),
				),
			);

		return {
			cookie: (httpEffect, { credential }) =>
				Effect.gen(function* () {
					const value = Redacted.value(credential);
					const caller =
						value.length > 0 ? yield* resolve(value) : Option.none();
					if (Option.isNone(caller) && requireAuth) {
						return yield* HttpApiError.Unauthorized.make();
					}
					if (Option.isSome(caller)) {
						const isRenewed = yield* renew(value);
						if (isRenewed) {
							yield* setSessionCookie(value, {
								path: baseUrl.pathname,
								maxAge: sessionTtl,
							});
						}
					}
					return yield* httpEffect.pipe(
						Effect.provideService(
							CurrentIdentity,
							caller.pipe(
								Option.match({
									onNone: () => anonymousIdentity,
									onSome: ({ user }) => user,
								}),
							),
						),
						Effect.provideService(CurrentSessionCaller, caller),
					);
				}),
		};
	}),
);

export const AdminTierMiddlewareLive = Layer.succeed(
	AdminTierMiddleware,
	(httpEffect) =>
		Effect.gen(function* () {
			const caller = yield* CurrentSessionCaller;
			if (Option.isNone(caller)) {
				return yield* HttpApiError.Unauthorized.make();
			}
			if (!isAdminTier(caller.value.user)) {
				return yield* HttpApiError.Forbidden.make();
			}
			return yield* httpEffect.pipe(
				Effect.provideService(CurrentUser, caller.value),
			);
		}),
);

export const SuperadminMiddlewareLive = Layer.succeed(
	SuperadminMiddleware,
	(httpEffect) =>
		Effect.gen(function* () {
			const caller = yield* CurrentSessionCaller;
			if (Option.isNone(caller)) {
				return yield* HttpApiError.Unauthorized.make();
			}
			if (!isSuperadmin(caller.value.user)) {
				return yield* HttpApiError.Forbidden.make();
			}
			return yield* httpEffect.pipe(
				Effect.provideService(CurrentUser, caller.value),
			);
		}),
);

export const ServiceAccountAuthenticationMiddlewareLive = Layer.effect(
	ServiceAccountAuthenticationMiddleware,
	Effect.gen(function* () {
		const context = yield* Effect.context<
			ServiceAccountRepositoryService | RoleRepositoryService | Crypto.Crypto
		>();
		const resolve = (token: string) =>
			resolveServiceAccountIdentity(token).pipe(
				Effect.provide(context),
				Effect.tapCause((cause) =>
					Effect.logError("API key lookup failed", cause),
				),
				Effect.catchTag(["BackendError", "PlatformError"], () =>
					HttpApiError.InternalServerError.make(),
				),
			);

		return {
			bearer: (httpEffect, { credential }) =>
				Effect.gen(function* () {
					const value = Redacted.value(credential);
					const resolved =
						value.length > 0 ? yield* resolve(value) : Option.none();
					if (Option.isNone(resolved)) {
						return yield* new HttpApiError.Unauthorized();
					}
					return yield* httpEffect.pipe(
						Effect.provideService(CurrentIdentity, resolved.value),
					);
				}),
		};
	}),
);
