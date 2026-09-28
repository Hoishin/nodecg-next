import { randomBytes } from "node:crypto";

import type { LoginAttempt } from "@nodecg-next/internal";
import { Clock, Duration, Effect, Schema } from "effect";

import { config } from "../server-config.ts";
import { LoginAttemptRepositoryService } from "../services/repository/login-attempt/login-attempt-repository.ts";
import {
	BackendError,
	KeyTaken,
} from "../services/repository/repository-errors.ts";

const insertLoginAttempt = Effect.fn("insertLoginAttempt")(
	function* (loginAttempt: LoginAttempt, expiresAt: number) {
		const repository = yield* LoginAttemptRepositoryService;
		const key = randomBytes(32).toString("base64url");
		yield* repository.create(key, loginAttempt, expiresAt);
		return key;
	},
	Effect.retry({ times: 2, while: Schema.is(KeyTaken) }),
	Effect.catchTag("KeyTaken", (cause) => BackendError.make({ cause })),
);

export const createLoginAttempt = Effect.fn("createLoginAttempt")(function* (
	loginAttempt: LoginAttempt,
) {
	const repository = yield* LoginAttemptRepositoryService;
	const ttl = yield* config.loginAttemptTtl;
	const now = yield* Clock.currentTimeMillis;
	yield* repository.deleteExpired(now);
	return yield* insertLoginAttempt(loginAttempt, now + Duration.toMillis(ttl));
});

export const consumeLoginAttempt = Effect.fn("consumeLoginAttempt")(function* (
	key: string,
) {
	const repository = yield* LoginAttemptRepositoryService;
	return yield* repository.consume(key, yield* Clock.currentTimeMillis);
});
