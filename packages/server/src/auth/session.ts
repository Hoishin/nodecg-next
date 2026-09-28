import { createHash, randomBytes } from "node:crypto";

import {
	type Authentication,
	type AuthenticationId,
	sessionCookieSecurity,
	UserSessionId,
} from "@nodecg-next/internal";
import { Clock, Duration, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { config } from "../server-config.ts";
import { AuthenticationRepositoryService } from "../services/repository/authentication/authentication-repository.ts";
import {
	BackendError,
	KeyTaken,
} from "../services/repository/repository-errors.ts";
import { SessionRepositoryService } from "../services/repository/session/session-repository.ts";
import { TransactionService } from "../services/transaction/transaction.ts";

const hashSessionToken = (token: string) =>
	UserSessionId.make(createHash("sha256").update(token).digest("base64url"));

export const cookieOptions = {
	httpOnly: true,
	sameSite: "lax",
	secure: false,
} as const;

export const setSessionCookie = (
	token: string,
	options: { readonly path: string; readonly maxAge: Duration.Input },
) =>
	HttpApiBuilder.securitySetCookie(sessionCookieSecurity, token, {
		...cookieOptions,
		path: options.path,
		maxAge: options.maxAge,
	});

const insertSession = Effect.fn("insertSession")(
	function* (authenticationId: AuthenticationId, expiresAt: number) {
		const sessions = yield* SessionRepositoryService;
		const token = randomBytes(32).toString("base64url");
		yield* sessions.create(
			hashSessionToken(token),
			authenticationId,
			expiresAt,
		);
		return token;
	},
	Effect.retry({ times: 2, while: Schema.is(KeyTaken) }),
	Effect.catchTag("KeyTaken", (cause) => BackendError.make({ cause })),
);

export const createSession = Effect.fn("createSession")(function* (
	authentication: Authentication,
) {
	const authentications = yield* AuthenticationRepositoryService;
	const tx = yield* TransactionService;
	const ttl = yield* config.sessionTtl;
	const now = yield* Clock.currentTimeMillis;

	return yield* tx.wrap(
		Effect.gen(function* () {
			const authenticationId =
				yield* authentications.findOrCreateAuthentication(authentication, now);
			return yield* insertSession(
				authenticationId,
				now + Duration.toMillis(ttl),
			);
		}),
	);
});

export const resolveSession = Effect.fn("resolveSession")(function* (
	token: string,
) {
	const authentications = yield* AuthenticationRepositoryService;
	const sessions = yield* SessionRepositoryService;
	const ttl = yield* config.sessionTtl;
	const now = yield* Clock.currentTimeMillis;

	const id = hashSessionToken(token);
	const authentication = yield* authentications.resolveBySession(id, now);
	if (Option.isSome(authentication)) {
		yield* sessions.refreshTTL(id, now + Duration.toMillis(ttl), now);
	}
	return authentication;
});

export const revokeSession = Effect.fn("revokeSession")(function* (
	token: string,
) {
	const sessions = yield* SessionRepositoryService;
	yield* sessions.revoke(hashSessionToken(token));
});
