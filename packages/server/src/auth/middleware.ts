import { isAdminTier, isSuperadmin } from "@nodecg-next/core";
import {
	AdminTierMiddleware,
	CurrentIdentity,
	UserAuthenticationMiddleware,
	ServiceAccountAuthenticationMiddleware,
	SuperadminMiddleware,
} from "@nodecg-next/internal";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpApiError } from "effect/unstable/httpapi";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { config } from "../server-config.ts";
import { AuthenticationRepositoryService } from "../services/repository/authentication/authentication-repository.ts";
import { SessionRepositoryService } from "../services/repository/session/session-repository.ts";
import { RoleStoreService } from "../services/role-store/role-store.ts";
import { ServiceAccountStoreService } from "../services/service-account-store/service-account-store.ts";
import {
	anonymousIdentity,
	resolveServiceAccountIdentity,
	resolveSessionIdentity,
} from "./identity.ts";
import { setSessionCookie } from "./session.ts";

export const UserAuthenticationMiddlewareLive = Layer.effect(
	UserAuthenticationMiddleware,
	Effect.gen(function* () {
		const requireAuth = yield* config.requireAuth;
		const baseUrl = yield* config.baseUrl;
		const sessionTtl = yield* config.sessionTtl;
		const context = yield* Effect.context<
			| AuthenticationRepositoryService
			| SessionRepositoryService
			| RoleStoreService
			| ConfiguredSuperadmins
		>();
		const resolve = (token: string) =>
			resolveSessionIdentity(token).pipe(
				Effect.provide(context),
				Effect.tapCause((cause) =>
					Effect.logError("Session lookup failed", cause),
				),
				Effect.catchTag(["BackendError", "ConfigError"], () =>
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
			if (!isSuperadmin(identity)) {
				return yield* new HttpApiError.Forbidden();
			}
			return yield* httpEffect;
		}),
);

export const ServiceAccountAuthenticationMiddlewareLive = Layer.effect(
	ServiceAccountAuthenticationMiddleware,
	Effect.gen(function* () {
		const serviceAccounts = yield* ServiceAccountStoreService;
		const resolve = resolveServiceAccountIdentity({ serviceAccounts });

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
