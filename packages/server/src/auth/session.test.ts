import { createHash } from "node:crypto";

import { type Authentication, AuthenticationId } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { ConfigProvider, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, vi } from "vitest";

import {
	type AuthenticationRepository,
	AuthenticationRepositoryService,
} from "../services/repository/authentication/authentication-repository.ts";
import { BackendError } from "../services/repository/repository-errors.ts";
import {
	type SessionRepository,
	SessionRepositoryService,
} from "../services/repository/session/session-repository.ts";
import { TransactionService } from "../services/transaction/transaction.ts";
import { createSession, resolveSession } from "./session.ts";

const alice: Authentication = {
	issuer: "dev",
	subject: "alice",
	displayName: "Alice",
};
const aliceAuthId = AuthenticationId.make("alice");

const findOrCreateAuthentication = vi.fn<
	AuthenticationRepository["findOrCreateAuthentication"]
>(() => Effect.succeed(aliceAuthId));
const resolveBySession = vi.fn<AuthenticationRepository["resolveBySession"]>(
	() => Effect.succeedNone,
);
const create = vi.fn<SessionRepository["create"]>(() => Effect.void);
const refreshTTL = vi.fn<SessionRepository["refreshTTL"]>(() => Effect.void);
const revoke = vi.fn<SessionRepository["revoke"]>(() => Effect.void);

afterEach(() => {
	for (const mock of [
		findOrCreateAuthentication,
		resolveBySession,
		create,
		refreshTTL,
		revoke,
	]) {
		mock.mockReset();
	}
});

const test = testLayer(
	Layer.mergeAll(
		Layer.succeed(AuthenticationRepositoryService, {
			findOrCreateAuthentication,
			resolveBySession,
		}),
		Layer.succeed(SessionRepositoryService, {
			create,
			refreshTTL,
			revoke,
		}),
		Layer.succeed(TransactionService, { wrap: (effect) => effect }),
		ConfigProvider.layer(
			ConfigProvider.fromEnvRecord({ SESSION_TTL: "1 hour" }),
		),
	),
);

const hashSessionToken = (token: string) =>
	createHash("sha256").update(token).digest("base64url");

describe("createSession", () => {
	test(
		"stores the session under the token's hash until the TTL runs out",
		Effect.gen(function* () {
			yield* TestClock.adjust("1 minute");
			const token = yield* createSession(alice);
			expect(findOrCreateAuthentication).toHaveBeenCalledWith(alice, 60_000);
			expect(create).toHaveBeenCalledWith(
				hashSessionToken(token),
				aliceAuthId,
				3_660_000,
			);
		}),
	);

	test(
		"writes the authentication and the session in one transaction",
		Effect.gen(function* () {
			const begin = vi.fn();
			yield* createSession(alice).pipe(
				Effect.provideService(TransactionService, {
					wrap: (effect) => {
						begin();
						return effect.pipe(
							Effect.andThen(BackendError.make({ cause: "rolled back" })),
						);
					},
				}),
				Effect.flip,
			);
			expect(begin).toHaveBeenCalledBefore(findOrCreateAuthentication);
			expect(create).toHaveBeenCalledOnce();
		}),
	);
});

describe("resolveSession", () => {
	test(
		"looks the session up by the token's hash and extends its TTL",
		Effect.gen(function* () {
			resolveBySession.mockReturnValueOnce(Effect.succeedSome(alice));
			yield* TestClock.adjust("1 minute");
			yield* resolveSession("token");
			expect(resolveBySession).toHaveBeenCalledWith(
				hashSessionToken("token"),
				60_000,
			);
			expect(refreshTTL).toHaveBeenCalledWith(
				hashSessionToken("token"),
				3_660_000,
				60_000,
			);
		}),
	);

	test(
		"leaves an unknown or expired session alone",
		Effect.gen(function* () {
			yield* resolveSession("token");
			expect(refreshTTL).not.toHaveBeenCalled();
		}),
	);
});
