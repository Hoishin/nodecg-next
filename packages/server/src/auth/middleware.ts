import {
	CurrentIdentity,
	HumanAuthenticationMiddleware,
	MachineAuthenticationMiddleware,
} from "@nodecg-next/internal";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpApiError } from "effect/unstable/httpapi";

import { config } from "../server-config.ts";
import { MachineClientStoreService } from "../services/machine-client-store/machine-client-store.ts";
import { RoleStoreService } from "../services/role-store/role-store.ts";
import { SessionStoreService } from "../services/session-store/session-store.ts";
import { resolveMachineIdentity } from "./resolve-machine-identity.ts";
import {
	anonymousIdentity,
	resolveSessionIdentity,
} from "./resolve-session-identity.ts";

export const HumanAuthenticationMiddlewareLive = Layer.effect(
	HumanAuthenticationMiddleware,
	Effect.gen(function* () {
		const requireAuth = yield* config.requireAuth;
		const sessions = yield* SessionStoreService;
		const roleStore = yield* RoleStoreService;
		const resolve = resolveSessionIdentity({ sessions, roleStore });

		return {
			cookie: (httpEffect, { credential }) =>
				Effect.gen(function* () {
					const value = Redacted.value(credential);
					const resolved =
						value.length > 0 ? yield* resolve(value) : Option.none();
					if (Option.isNone(resolved) && requireAuth) {
						return yield* new HttpApiError.Unauthorized();
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

export const MachineAuthenticationMiddlewareLive = Layer.effect(
	MachineAuthenticationMiddleware,
	Effect.gen(function* () {
		const machines = yield* MachineClientStoreService;
		const resolve = resolveMachineIdentity({ machines });

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
