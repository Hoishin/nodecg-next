import { HttpApiError, HttpServerRequest } from "@effect/platform";
import {
	AuthenticationMiddleware,
	PublicIdentitySchema,
} from "@nodecg/internal";
import { Effect, Layer, Option } from "effect";

import { config } from "../server-config.ts";
import { SessionStoreService } from "../services/session-store/session-store.ts";
import { sessionCookieName } from "./session-cookie-name.ts";

const publicIdentity = PublicIdentitySchema.make();

export const AuthenticationMiddlewareLive = Layer.effect(
	AuthenticationMiddleware,
	Effect.gen(function* () {
		const requireAuth = yield* config.requireAuth;
		const sessions = yield* SessionStoreService;

		return Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const sessionId = Option.fromNullable(request.cookies[sessionCookieName]);
			if (Option.isSome(sessionId)) {
				const resolved = yield* sessions.lookup(sessionId.value);
				if (Option.isSome(resolved)) {
					yield* sessions.refreshTTL(sessionId.value);
					return resolved.value;
				}
			}
			if (requireAuth) {
				return yield* new HttpApiError.Unauthorized();
			}
			return publicIdentity;
		});
	}),
);
