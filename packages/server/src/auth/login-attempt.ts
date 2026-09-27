import { randomBytes } from "node:crypto";

import type { LoginAttempt } from "@nodecg-next/internal";
import { Clock, Duration, Effect } from "effect";

import { config } from "../server-config.ts";
import { LoginAttemptRepositoryService } from "../services/repository/login-attempt/login-attempt-repository.ts";

export const createLoginAttempt = Effect.fn("createLoginAttempt")(function* (
	loginAttempt: LoginAttempt,
) {
	const repository = yield* LoginAttemptRepositoryService;
	const ttl = yield* config.loginAttemptTtl;
	const now = yield* Clock.currentTimeMillis;
	const key = randomBytes(32).toString("base64url");
	yield* repository.deleteExpired(now);
	yield* repository.create(key, loginAttempt, now + Duration.toMillis(ttl));
	return key;
});

export const consumeLoginAttempt = Effect.fn("consumeLoginAttempt")(function* (
	key: string,
) {
	const repository = yield* LoginAttemptRepositoryService;
	return yield* repository.consume(key, yield* Clock.currentTimeMillis);
});
