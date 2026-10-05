import {
	type Authentication,
	type AuthenticationId,
	sessionCookieSecurity,
	UserSessionId,
} from "@nodecg-next/internal";
import {
	Crypto,
	DateTime,
	type Duration,
	Effect,
	Encoding,
	Schema,
} from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { config } from "../server-config.ts";
import { AuthenticationRepositoryService } from "../services/repository/authentication/authentication-repository.ts";
import {
	BackendError,
	KeyTaken,
} from "../services/repository/repository-errors.ts";
import { SessionRepositoryService } from "../services/repository/session/session-repository.ts";
import { TransactionService } from "../services/transaction/transaction.ts";

export const hashSessionToken = Effect.fnUntraced(function* (token: string) {
	const crypto = yield* Crypto.Crypto;
	const digest = yield* crypto.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return UserSessionId.make(Encoding.encodeBase64Url(digest));
});

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
	function* (authenticationId: AuthenticationId, expiresAt: DateTime.DateTime) {
		const crypto = yield* Crypto.Crypto;
		const sessions = yield* SessionRepositoryService;
		const bytes = yield* crypto.randomBytes(32);
		const token = Encoding.encodeBase64Url(bytes);
		const id = yield* hashSessionToken(token);
		yield* sessions.create(id, authenticationId, expiresAt);
		return token;
	},
	Effect.retry({ times: 2, while: Schema.is(KeyTaken) }),
	Effect.catchTag("KeyTaken", (cause) => BackendError.make({ cause })),
);

export const createSession = Effect.fn("createSession")(function* (
	authentication: Authentication,
	displayName: string,
) {
	const authentications = yield* AuthenticationRepositoryService;
	const tx = yield* TransactionService;
	const ttl = yield* config.sessionTtl;
	const now = yield* DateTime.now;

	return yield* tx.wrap(
		Effect.gen(function* () {
			const { authenticationId } =
				yield* authentications.findOrCreateAuthentication(
					authentication,
					displayName,
				);
			return yield* insertSession(
				authenticationId,
				DateTime.addDuration(now, ttl),
			);
		}),
	);
});

export const renewSession = Effect.fn("renewSession")(function* (
	token: string,
) {
	const sessions = yield* SessionRepositoryService;
	const ttl = yield* config.sessionTtl;
	const interval = yield* config.sessionRenewInterval;
	const now = yield* DateTime.now;

	const id = yield* hashSessionToken(token);
	const expiresAt = DateTime.addDuration(now, ttl);
	return yield* sessions.refreshTTL(
		id,
		expiresAt,
		DateTime.subtractDuration(expiresAt, interval), // expiry < (now + ttl - interval) means it was renewed over one interval ago
	);
});

export const revokeSession = Effect.fn("revokeSession")(function* (
	token: string,
) {
	const sessions = yield* SessionRepositoryService;
	const id = yield* hashSessionToken(token);
	yield* sessions.revoke(id);
});
