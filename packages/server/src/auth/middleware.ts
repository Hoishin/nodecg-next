import { HttpApiError } from "@effect/platform";
import {
	HumanAuthenticationMiddleware,
	MachineAuthenticationMiddleware,
} from "@nodecg/internal";
import { Effect, Layer, Option, Redacted } from "effect";

import { config } from "../server-config.ts";
import { RoleStoreService } from "../services/role-store/role-store.ts";
import { SessionStoreService } from "../services/session-store/session-store.ts";
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
			cookie: (cookie: Redacted.Redacted<string>) =>
				Effect.gen(function* () {
					const value = Redacted.value(cookie);
					const resolved = yield* resolve(
						value.length === 0 ? Option.none() : Option.some(value),
					);
					if (Option.isSome(resolved)) {
						return resolved.value;
					}
					if (requireAuth) {
						return yield* new HttpApiError.Unauthorized();
					}
					return anonymousIdentity;
				}),
		};
	}),
);

export const MachineAuthenticationMiddlewareLive = Layer.succeed(
	MachineAuthenticationMiddleware,
	{ bearer: () => new HttpApiError.Unauthorized() },
);
