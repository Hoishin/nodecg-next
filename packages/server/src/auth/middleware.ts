import { HttpApiError, HttpServerRequest } from "@effect/platform";
import {
	AuthenticationMiddleware,
	HumanIdentitySchema,
	PublicIdentitySchema,
} from "@nodecg/internal";
import { Effect, Layer, Option } from "effect";

import { config } from "../server-config.ts";
import { RoleStoreService } from "../services/role-store/role-store.ts";
import { SessionStoreService } from "../services/session-store/session-store.ts";
import { sessionCookieName } from "./session-cookie-name.ts";

const publicIdentity = PublicIdentitySchema.make();

export const AuthenticationMiddlewareLive = Layer.effect(
	AuthenticationMiddleware,
	Effect.gen(function* () {
		const requireAuth = yield* config.requireAuth;
		const sessions = yield* SessionStoreService;
		const roleStore = yield* RoleStoreService;

		return Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const sessionId = Option.fromNullable(request.cookies[sessionCookieName]);
			if (Option.isSome(sessionId)) {
				const resolved = yield* sessions.lookup(sessionId.value);
				if (Option.isSome(resolved)) {
					yield* sessions.refreshTTL(sessionId.value);
					const account = resolved.value;
					const roles = yield* roleStore.get({
						issuer: account.issuer,
						subject: account.subject,
					});
					return HumanIdentitySchema.make({ account, roles });
				}
			}
			if (requireAuth) {
				return yield* new HttpApiError.Unauthorized();
			}
			return publicIdentity;
		});
	}),
);
