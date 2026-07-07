import { HttpApiError, HttpServerRequest } from "@effect/platform";
import { AuthenticationMiddleware } from "@nodecg/internal";
import { Effect, Layer, Option } from "effect";

import { config } from "../server-config.ts";
import { RoleStoreService } from "../services/role-store/role-store.ts";
import { SessionStoreService } from "../services/session-store/session-store.ts";
import {
	anonymousIdentity,
	resolveSessionIdentity,
} from "./resolve-session-identity.ts";

export const AuthenticationMiddlewareLive = Layer.effect(
	AuthenticationMiddleware,
	Effect.gen(function* () {
		const requireAuth = yield* config.requireAuth;
		const sessions = yield* SessionStoreService;
		const roleStore = yield* RoleStoreService;
		const resolve = resolveSessionIdentity({ sessions, roleStore });

		return Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const resolved = yield* resolve(request);
			if (Option.isSome(resolved)) {
				return resolved.value;
			}
			if (requireAuth) {
				return yield* new HttpApiError.Unauthorized();
			}
			return anonymousIdentity;
		});
	}),
);
