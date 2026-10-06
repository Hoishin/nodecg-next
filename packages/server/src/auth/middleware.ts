import { isAdminTier, isSuperadmin } from "@nodecg-next/core";
import {
	AdminTierMiddleware,
	CurrentServiceAccount,
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
	resolveServiceAccountCaller,
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

		return {
			cookie: (httpEffect, { credential }) =>
				Effect.gen(function* () {
					const value = Redacted.value(credential);
					const caller =
						value.length > 0
							? yield* resolveSessionCaller(value).pipe(
									Effect.provide(context),
									Effect.tapCause((cause) =>
										Effect.logError("Session lookup failed", cause),
									),
									Effect.catchTag(["BackendError", "PlatformError"], () =>
										HttpApiError.InternalServerError.make(),
									),
								)
							: Option.none();
					if (Option.isNone(caller) && requireAuth) {
						return yield* HttpApiError.Unauthorized.make();
					}
					if (Option.isSome(caller)) {
						const isRenewed = yield* renewSession(value).pipe(
							Effect.provide(context),
							Effect.tapCause((cause) =>
								Effect.logError("Session renewal failed", cause),
							),
							Effect.catchTag(
								["BackendError", "ConfigError", "PlatformError"],
								() => HttpApiError.InternalServerError.make(),
							),
						);
						if (isRenewed) {
							yield* setSessionCookie(value, {
								path: baseUrl.pathname,
								maxAge: sessionTtl,
							});
						}
					}
					return yield* httpEffect.pipe(
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

		return {
			bearer: (httpEffect, { credential }) =>
				Effect.gen(function* () {
					const value = Redacted.value(credential);
					const caller =
						value.length > 0
							? yield* resolveServiceAccountCaller(value).pipe(
									Effect.provide(context),
									Effect.tapCause((cause) =>
										Effect.logError("API key lookup failed", cause),
									),
									Effect.catchTag(["BackendError", "PlatformError"], () =>
										HttpApiError.InternalServerError.make(),
									),
								)
							: Option.none();
					if (Option.isNone(caller)) {
						return yield* HttpApiError.Unauthorized.make();
					}
					return yield* httpEffect.pipe(
						Effect.provideService(CurrentServiceAccount, caller.value),
					);
				}),
		};
	}),
);
