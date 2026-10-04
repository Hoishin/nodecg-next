import { isAdminTier, isSuperadmin } from "@nodecg-next/core";
import {
	AdminTierMiddleware,
	AnonymousIdentitySchema,
	CurrentIdentity,
	UserAuthenticationMiddleware,
	ServiceAccountAuthenticationMiddleware,
	SuperadminMiddleware,
} from "@nodecg-next/internal";
import { type Crypto, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpApiError } from "effect/unstable/httpapi";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { config } from "../server-config.ts";
import { AccountRepositoryService } from "../services/repository/account/account-repository.ts";
import { AuthenticationRepositoryService } from "../services/repository/authentication/authentication-repository.ts";
import { RoleRepositoryService } from "../services/repository/role/role-repository.ts";
import { ServiceAccountRepositoryService } from "../services/repository/service-account/service-account-repository.ts";
import { SessionRepositoryService } from "../services/repository/session/session-repository.ts";
import {
	anonymousIdentity,
	resolveServiceAccountIdentity,
	resolveSessionIdentity,
} from "./identity.ts";
import { setSessionCookie } from "./session.ts";

const isAnonymous = Schema.is(AnonymousIdentitySchema);

export const UserAuthenticationMiddlewareLive = Layer.effect(
	UserAuthenticationMiddleware,
	Effect.gen(function* () {
		const requireAuth = yield* config.requireAuth;
		const baseUrl = yield* config.baseUrl;
		const sessionTtl = yield* config.sessionTtl;
		const context = yield* Effect.context<
			| AuthenticationRepositoryService
			| SessionRepositoryService
			| AccountRepositoryService
			| RoleRepositoryService
			| ConfiguredSuperadmins
			| Crypto.Crypto
		>();
		const resolve = (token: string) =>
			resolveSessionIdentity(token).pipe(
				Effect.provide(context),
				Effect.tapCause((cause) =>
					Effect.logError("Session lookup failed", cause),
				),
				Effect.catchTag(["BackendError", "ConfigError", "PlatformError"], () =>
					HttpApiError.InternalServerError.make(),
				),
			);

		return {
			cookie: (httpEffect, { credential }) =>
				Effect.gen(function* () {
					const value = Redacted.value(credential);
					const resolved =
						value.length > 0 ? yield* resolve(value) : Option.none();
					if (Option.isNone(resolved) && requireAuth) {
						return yield* new HttpApiError.Unauthorized();
					}
					if (Option.isSome(resolved)) {
						yield* setSessionCookie(value, {
							path: baseUrl.pathname,
							maxAge: sessionTtl,
						});
					}
					return yield* Effect.provideService(
						httpEffect,
						CurrentIdentity,
						Option.getOrElse(resolved, () => anonymousIdentity),
					);
				}),
		};
	}),
);

export const AdminTierMiddlewareLive = Layer.succeed(
	AdminTierMiddleware,
	(httpEffect) =>
		Effect.gen(function* () {
			const identity = yield* CurrentIdentity;
			if (isAnonymous(identity)) {
				return yield* HttpApiError.Unauthorized.make();
			}
			if (!isAdminTier(identity)) {
				return yield* new HttpApiError.Forbidden();
			}
			return yield* httpEffect;
		}),
);

export const SuperadminMiddlewareLive = Layer.succeed(
	SuperadminMiddleware,
	(httpEffect) =>
		Effect.gen(function* () {
			const identity = yield* CurrentIdentity;
			if (isAnonymous(identity)) {
				return yield* HttpApiError.Unauthorized.make();
			}
			if (!isSuperadmin(identity)) {
				return yield* new HttpApiError.Forbidden();
			}
			return yield* httpEffect;
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
					return yield* Effect.provideService(
						httpEffect,
						CurrentIdentity,
						resolved.value,
					);
				}),
		};
	}),
);
