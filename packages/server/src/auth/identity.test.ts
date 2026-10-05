import { NodeCrypto } from "@effect/platform-node";
import {
	AccountId,
	Authentication,
	Role,
	RoleNameSchema,
	User,
	UserId,
} from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import {
	type SessionRepository,
	SessionRepositoryService,
} from "../services/repository/session/session-repository.ts";
import { resolveSessionIdentity } from "./identity.ts";
import { hashSessionToken } from "./session.ts";

const alice = Authentication.make({ issuer: "dev", subject: "alice" });
const aliceSecondAuthentication = Authentication.make({
	issuer: "twitch",
	subject: "alice",
});
const root = Authentication.make({ issuer: "dev", subject: "root" });
const viewer = Role.make({
	namespace: "show",
	name: RoleNameSchema.make("viewer"),
});

const aliceUser = {
	id: UserId.make("alice-user"),
	accountId: AccountId.make("alice-account"),
	displayName: "Alice",
	authentications: [alice],
	roles: [viewer],
	globalRoles: ["admin" as const],
};

const resolve = vi.fn<SessionRepository["resolve"]>(() => Effect.succeedNone);

afterEach(() => {
	resolve.mockReset();
});

const test = testLayer(
	Layer.mergeAll(
		Layer.succeed(SessionRepositoryService, {
			create: vi.fn(),
			resolve,
			refreshTTL: vi.fn(),
			revoke: vi.fn(),
		}),
		Layer.succeed(ConfiguredSuperadmins, [root, aliceSecondAuthentication]),
		NodeCrypto.layer,
	),
);

describe("resolveSessionIdentity", () => {
	test(
		"resolves the session to its user, with the roles of its account",
		Effect.gen(function* () {
			resolve.mockReturnValueOnce(
				Effect.succeedSome({ authentication: alice, user: aliceUser }),
			);

			const identity = yield* resolveSessionIdentity("token");

			expect(identity).toStrictEqual(
				Option.some(
					User.make({
						id: UserId.make("alice-user"),
						authentication: alice,
						displayName: "Alice",
						roles: [viewer],
						globalRoles: ["admin"],
					}),
				),
			);
		}),
	);

	test(
		"adds superadmin when any of the user's authentications is in config",
		Effect.gen(function* () {
			resolve.mockReturnValueOnce(
				Effect.succeedSome({
					authentication: alice,
					user: {
						...aliceUser,
						authentications: [alice, aliceSecondAuthentication],
					},
				}),
			);

			const identity = yield* resolveSessionIdentity("token");

			expect(identity).toStrictEqual(
				Option.some(
					User.make({
						id: UserId.make("alice-user"),
						authentication: alice,
						displayName: "Alice",
						roles: [viewer],
						globalRoles: ["admin", "superadmin"],
					}),
				),
			);
		}),
	);

	test(
		"looks the session up by the token's hash",
		Effect.gen(function* () {
			yield* resolveSessionIdentity("token");

			const id = yield* hashSessionToken("token");
			expect(resolve).toHaveBeenCalledExactlyOnceWith(id);
		}),
	);

	test(
		"resolves nothing without a live session",
		Effect.gen(function* () {
			const identity = yield* resolveSessionIdentity("token");

			expect(identity).toStrictEqual(Option.none());
		}),
	);
});
