import { NodeCrypto } from "@effect/platform-node";
import {
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
import { resolveSessionCaller } from "./identity.ts";
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

describe("resolveSessionCaller", () => {
	test(
		"resolves the session to its user, with the roles of its account",
		Effect.gen(function* () {
			resolve.mockReturnValueOnce(
				Effect.succeedSome({ authentication: alice, user: aliceUser }),
			);

			const caller = yield* resolveSessionCaller("token");

			expect(caller).toStrictEqual(
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

			const caller = yield* resolveSessionCaller("token");

			expect(caller).toStrictEqual(
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
			yield* resolveSessionCaller("token");

			const id = yield* hashSessionToken("token");
			expect(resolve).toHaveBeenCalledExactlyOnceWith(id);
		}),
	);

	test(
		"resolves nothing without a live session",
		Effect.gen(function* () {
			const caller = yield* resolveSessionCaller("token");

			expect(caller).toStrictEqual(Option.none());
		}),
	);
});
