import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { AccountId, type Role, RoleName } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Array, Effect, HashMap, HashSet, Layer, Option, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { assert, describe, expect } from "vitest";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { AccountRepositoryService } from "../account/account-repository.ts";
import { DrizzleSqliteAccountRepository } from "../account/drizzle-sqlite-account-repository.ts";
import { AuthenticationRepositoryService } from "../authentication/authentication-repository.ts";
import { DrizzleSqliteAuthenticationRepository } from "../authentication/drizzle-sqlite-authentication-repository.ts";
import { BackendError } from "../repository-errors.ts";
import { DrizzleSqliteRoleRepository } from "./drizzle-sqlite-role-repository.ts";
import { RoleRepositoryService, UnknownAccount } from "./role-repository.ts";

const test = testLayer(
	Layer.mergeAll(
		DrizzleSqliteRoleRepository,
		DrizzleSqliteAccountRepository,
		DrizzleSqliteAuthenticationRepository,
	).pipe(
		Layer.provideMerge(
			Layer.effect(
				DrizzleSqliteDatabaseService,
				DrizzleSqliteDatabaseService.make(":memory:"),
			),
		),
		Layer.provide(
			Layer.mergeAll(
				NodeFileSystem.layer,
				NodePath.layer,
				NodeCrypto.layer,
				Reactivity.layer,
			),
		),
	),
);

const viewer: Role = { namespace: "show", name: RoleName("viewer") };
const producer: Role = { namespace: "show", name: RoleName("producer") };
const otherViewer: Role = { namespace: "other", name: RoleName("viewer") };

const createAccount = Effect.fn(function* (
	subject: string,
	displayName: string = subject,
) {
	const authentications = yield* AuthenticationRepositoryService;
	const accounts = yield* AccountRepositoryService;
	yield* authentications.findOrCreateAuthentication(
		{ issuer: "dev", subject },
		displayName,
	);
	const accountId = yield* accounts.resolveByAuthentication({
		issuer: "dev",
		subject,
	});
	assert(Option.isSome(accountId));
	return accountId.value;
});

describe("read", () => {
	test(
		"reads the roles and global roles granted to the account only",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const alice = yield* createAccount("alice");
			const bob = yield* createAccount("bob");
			yield* repository.grantRoles(HashMap.make([alice, HashSet.make(viewer)]));
			yield* repository.grantGlobalRole(alice, "admin");
			yield* repository.grantRoles(HashMap.make([bob, HashSet.make(producer)]));
			yield* repository.grantGlobalRole(bob, "superadmin");

			expect(yield* repository.read(alice)).toStrictEqual({
				roles: [viewer],
				globalRoles: ["admin"],
			});
		}),
	);
});

describe("grantRoles", () => {
	test(
		"inserts every role of the set for the account only, keeping one grant per role",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const alice = yield* createAccount("alice");
			const bob = yield* createAccount("bob");
			yield* repository.grantRoles(HashMap.make([alice, HashSet.make(viewer)]));

			yield* repository.grantRoles(
				HashMap.make([alice, HashSet.make(viewer, producer, otherViewer)]),
			);

			const { roles } = yield* repository.read(alice);
			expect(roles).toHaveLength(3);
			expect(roles).toEqual(
				expect.arrayContaining([viewer, producer, otherViewer]),
			);
			const bobGrants = yield* repository.read(bob);
			expect(bobGrants.roles).toStrictEqual([]);
		}),
	);

	test(
		"inserts each account's own roles when given several accounts",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const alice = yield* createAccount("alice");
			const bob = yield* createAccount("bob");

			yield* repository.grantRoles(
				HashMap.make(
					[alice, HashSet.make(viewer)],
					[bob, HashSet.make(producer)],
				),
			);

			const aliceGrants = yield* repository.read(alice);
			expect(aliceGrants.roles).toStrictEqual([viewer]);
			const bobGrants = yield* repository.read(bob);
			expect(bobGrants.roles).toStrictEqual([producer]);
		}),
	);

	test(
		"inserts more roles than fit in one statement",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const alice = yield* createAccount("alice");
			const roles = Array.makeBy(10_923, (index) => ({
				namespace: "show",
				name: RoleName(`role-${index}`),
			}));

			yield* repository.grantRoles(
				HashMap.make([alice, HashSet.fromIterable(roles)]),
			);

			const grants = yield* repository.read(alice);
			expect(grants.roles).toHaveLength(10_923);
		}),
	);

	test(
		"inserts nothing for an empty set",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const alice = yield* createAccount("alice");

			yield* repository.grantRoles(HashMap.make([alice, HashSet.empty()]));

			const grants = yield* repository.read(alice);
			expect(grants.roles).toStrictEqual([]);
		}),
	);

	test(
		"fails with a backend error when the account does not exist",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;

			const error = yield* repository
				.grantRoles(
					HashMap.make([AccountId.make("missing"), HashSet.make(viewer)]),
				)
				.pipe(Effect.flip);

			assert(Schema.is(BackendError)(error));
		}),
	);
});

describe("grantRole", () => {
	test(
		"keeps one grant when the same role is inserted twice",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const alice = yield* createAccount("alice");
			yield* repository.grantRole(alice, viewer);
			yield* repository.grantRole(alice, viewer);

			expect((yield* repository.read(alice)).roles).toStrictEqual([viewer]);
		}),
	);

	test(
		"fails with UnknownAccount when the account does not exist",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const missing = AccountId.make("missing");

			const error = yield* repository
				.grantRole(missing, viewer)
				.pipe(Effect.flip);

			expect(error).toStrictEqual(UnknownAccount.make({ accountId: missing }));
		}),
	);
});

describe("revokeRole", () => {
	test(
		"deletes the role in its namespace only",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const alice = yield* createAccount("alice");
			yield* repository.grantRoles(
				HashMap.make([alice, HashSet.make(viewer, otherViewer)]),
			);

			yield* repository.revokeRole(alice, viewer);

			expect((yield* repository.read(alice)).roles).toStrictEqual([
				otherViewer,
			]);
		}),
	);

	test(
		"fails with UnknownAccount when the account does not exist",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const missing = AccountId.make("missing");

			const error = yield* repository
				.revokeRole(missing, viewer)
				.pipe(Effect.flip);

			expect(error).toStrictEqual(UnknownAccount.make({ accountId: missing }));
		}),
	);
});

describe("grantGlobalRole", () => {
	test(
		"keeps one grant when the same global role is inserted twice",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const alice = yield* createAccount("alice");
			yield* repository.grantGlobalRole(alice, "admin");
			yield* repository.grantGlobalRole(alice, "admin");

			expect((yield* repository.read(alice)).globalRoles).toStrictEqual([
				"admin",
			]);
		}),
	);

	test(
		"fails with UnknownAccount when the account does not exist",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const missing = AccountId.make("missing");

			const error = yield* repository
				.grantGlobalRole(missing, "admin")
				.pipe(Effect.flip);

			expect(error).toStrictEqual(UnknownAccount.make({ accountId: missing }));
		}),
	);
});

describe("revokeGlobalRole", () => {
	test(
		"deletes the named global role only",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const alice = yield* createAccount("alice");
			yield* repository.grantGlobalRole(alice, "admin");
			yield* repository.grantGlobalRole(alice, "superadmin");

			yield* repository.revokeGlobalRole(alice, "superadmin");

			expect((yield* repository.read(alice)).globalRoles).toStrictEqual([
				"admin",
			]);
		}),
	);

	test(
		"fails with UnknownAccount when the account does not exist",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const missing = AccountId.make("missing");

			const error = yield* repository
				.revokeGlobalRole(missing, "admin")
				.pipe(Effect.flip);

			expect(error).toStrictEqual(UnknownAccount.make({ accountId: missing }));
		}),
	);
});

describe("globalRoleExists", () => {
	test(
		"reports whether any account holds the global role",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const alice = yield* createAccount("alice");
			yield* repository.grantGlobalRole(alice, "admin");

			expect(yield* repository.globalRoleExists("admin")).toBe(true);
			expect(yield* repository.globalRoleExists("superadmin")).toBe(false);
		}),
	);
});

describe("listAll", () => {
	test(
		"lists each authentication with its account's name and grants and leaves out accounts without grants",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const alice = yield* createAccount("alice", "Alice");
			const bob = yield* createAccount("bob", "Bob");
			yield* createAccount("carol");
			yield* repository.grantRoles(HashMap.make([alice, HashSet.make(viewer)]));
			yield* repository.grantGlobalRole(bob, "admin");

			const assignments = yield* repository.listAll();
			expect(assignments).toStrictEqual([
				{
					authentication: { issuer: "dev", subject: "alice" },
					displayName: "Alice",
					roles: [viewer],
					globalRoles: [],
				},
				{
					authentication: { issuer: "dev", subject: "bob" },
					displayName: "Bob",
					roles: [],
					globalRoles: ["admin"],
				},
			]);
		}),
	);
});

describe("revokeAllRoles", () => {
	test(
		"deletes every account's roles and keeps their global roles",
		Effect.gen(function* () {
			const repository = yield* RoleRepositoryService;
			const alice = yield* createAccount("alice");
			const bob = yield* createAccount("bob");
			yield* repository.grantRoles(HashMap.make([alice, HashSet.make(viewer)]));
			yield* repository.grantGlobalRole(alice, "admin");
			yield* repository.grantRoles(HashMap.make([bob, HashSet.make(producer)]));

			yield* repository.revokeAllRoles();

			const aliceGrants = yield* repository.read(alice);
			expect(aliceGrants).toStrictEqual({ roles: [], globalRoles: ["admin"] });
			const bobGrants = yield* repository.read(bob);
			expect(bobGrants).toStrictEqual({ roles: [], globalRoles: [] });
		}),
	);
});
