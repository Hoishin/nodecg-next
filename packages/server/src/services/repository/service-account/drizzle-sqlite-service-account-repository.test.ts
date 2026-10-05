import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { type Role, RoleName, ServiceAccountId } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Reactivity } from "effect/unstable/reactivity";
import { assert, describe, expect } from "vitest";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import {
	apiKeys,
	serviceAccounts,
} from "../../database/drizzle-sqlite/tables.ts";
import { AuthenticationRepositoryService } from "../authentication/authentication-repository.ts";
import { DrizzleSqliteAuthenticationRepository } from "../authentication/drizzle-sqlite-authentication-repository.ts";
import { BackendError } from "../repository-errors.ts";
import { DrizzleSqliteRoleRepository } from "../role/drizzle-sqlite-role-repository.ts";
import { RoleRepositoryService } from "../role/role-repository.ts";
import { DrizzleSqliteServiceAccountRepository } from "./drizzle-sqlite-service-account-repository.ts";
import { ServiceAccountRepositoryService } from "./service-account-repository.ts";

const test = testLayer(
	Layer.mergeAll(
		DrizzleSqliteServiceAccountRepository,
		DrizzleSqliteRoleRepository,
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
const ghost = ServiceAccountId.make("00000000-0000-4000-8000-0000000000ff");

const createBot = Effect.fn(function* (displayName: string, hash: string) {
	const repository = yield* ServiceAccountRepositoryService;
	const authentications = yield* AuthenticationRepositoryService;
	const boss = yield* authentications.findOrCreateAuthentication(
		{ issuer: "dev", subject: "boss" },
		"Boss",
	);
	const { serviceAccountId, accountId } = yield* repository.create({
		displayName,
		createdBy: boss.accountId,
	});
	yield* repository.addKey(serviceAccountId, { hash, label: "" });
	return { serviceAccountId, accountId };
});

const createdBy = Effect.fn(function* (id: ServiceAccountId) {
	const db = yield* DrizzleSqliteDatabaseService;
	const rows = yield* db
		.select({ createdBy: serviceAccounts.createdBy })
		.from(serviceAccounts)
		.where(eq(serviceAccounts.id, id));
	return rows;
});

describe("create", () => {
	test(
		"creates a service account under its own named account",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const { serviceAccountId: id } = yield* createBot("scoreboard", "hash-1");

			const listed = yield* repository.listAll();
			expect(
				listed.map(({ id, displayName }) => ({ id, displayName })),
			).toStrictEqual([{ id, displayName: "scoreboard" }]);
		}),
	);

	test(
		"records the creating account",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const { accountId: provisionerAccount } = yield* createBot(
				"provisioner",
				"hash-1",
			);

			const created = yield* repository.create({
				displayName: "scoreboard",
				createdBy: provisionerAccount,
			});

			const rows = yield* createdBy(created.serviceAccountId);
			expect(rows).toStrictEqual([{ createdBy: provisionerAccount }]);
			const resolved = yield* repository.resolveById(created.serviceAccountId);
			assert(Option.isSome(resolved));
			expect(created.accountId).toBe(resolved.value.accountId);
		}),
	);
});

describe("createWithId", () => {
	test(
		"creates a service account under the given id",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const authentications = yield* AuthenticationRepositoryService;
			const boss = yield* authentications.findOrCreateAuthentication(
				{ issuer: "dev", subject: "boss" },
				"Boss",
			);

			const created = yield* repository.createWithId({
				id: ghost,
				displayName: "scoreboard",
				createdBy: boss.accountId,
			});

			expect(created.serviceAccountId).toBe(ghost);
			const resolved = yield* repository.resolveById(ghost);
			expect(resolved).toStrictEqual(
				Option.some({
					id: ghost,
					accountId: created.accountId,
					displayName: "scoreboard",
				}),
			);
			const rows = yield* createdBy(ghost);
			expect(rows).toStrictEqual([{ createdBy: boss.accountId }]);
		}),
	);

	test(
		"fails with BackendError when the id is taken",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const authentications = yield* AuthenticationRepositoryService;
			const boss = yield* authentications.findOrCreateAuthentication(
				{ issuer: "dev", subject: "boss" },
				"Boss",
			);
			const created = yield* repository.createWithId({
				id: ghost,
				displayName: "scoreboard",
				createdBy: boss.accountId,
			});

			const error = yield* repository
				.createWithId({
					id: ghost,
					displayName: "timer",
					createdBy: boss.accountId,
				})
				.pipe(Effect.flip);

			assert(Schema.is(BackendError)(error));
			expect(error.message).toContain(
				"UNIQUE constraint failed: service_accounts.id",
			);
			const listed = yield* repository.listAll();
			expect(listed).toStrictEqual([
				{
					id: ghost,
					accountId: created.accountId,
					displayName: "scoreboard",
					roles: [],
					globalRoles: [],
				},
			]);
		}),
	);
});

describe("resolveById", () => {
	test(
		"resolves an id to its service account",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			yield* createBot("timer", "hash-1");
			const { serviceAccountId: scoreboard, accountId } = yield* createBot(
				"scoreboard",
				"hash-2",
			);

			const resolved = yield* repository.resolveById(scoreboard);
			expect(resolved).toStrictEqual(
				Option.some({ id: scoreboard, accountId, displayName: "scoreboard" }),
			);
		}),
	);

	test(
		"treats an unknown id as absent",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			yield* createBot("scoreboard", "hash-1");

			const resolved = yield* repository.resolveById(ghost);
			expect(resolved).toStrictEqual(Option.none());
		}),
	);
});

describe("resolveByKeyHash", () => {
	test(
		"resolves a key to its service account",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const { serviceAccountId: id, accountId } = yield* createBot(
				"scoreboard",
				"hash-1",
			);

			const byKey = yield* repository.resolveByKeyHash("hash-1");

			expect(byKey).toStrictEqual(
				Option.some({ id, accountId, displayName: "scoreboard" }),
			);
		}),
	);

	test(
		"resolves nothing for an unknown key",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			yield* createBot("scoreboard", "hash-1");

			const resolved = yield* repository.resolveByKeyHash("hash-2");

			expect(resolved).toStrictEqual(Option.none());
		}),
	);

	test(
		"resolves a key until it expires",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;
			const { serviceAccountId: id } = yield* createBot("scoreboard", "hash-1");
			yield* db
				.update(apiKeys)
				.set({ expiresAt: 100 })
				.where(eq(apiKeys.serviceAccountId, id));

			yield* TestClock.setTime(99);
			const before = yield* repository.resolveByKeyHash("hash-1");
			assert(Option.isSome(before));
			yield* TestClock.setTime(100);
			const at = yield* repository.resolveByKeyHash("hash-1");
			expect(at).toStrictEqual(Option.none());
		}),
	);
});

describe("listAll", () => {
	test(
		"lists every service account with its own roles and global roles",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const roleRepository = yield* RoleRepositoryService;
			const { serviceAccountId: scoreboard, accountId: scoreboardAccountId } =
				yield* createBot("scoreboard", "hash-1");
			const { serviceAccountId: timer, accountId: timerAccountId } =
				yield* createBot("timer", "hash-2");
			yield* repository.grantRole(scoreboard, viewer);
			yield* roleRepository.grantGlobalRole(scoreboardAccountId, "admin");

			const listed = yield* repository.listAll();

			expect(listed).toEqual(
				expect.arrayContaining([
					{
						id: scoreboard,
						accountId: scoreboardAccountId,
						displayName: "scoreboard",
						roles: [viewer],
						globalRoles: ["admin"],
					},
					{
						id: timer,
						accountId: timerAccountId,
						displayName: "timer",
						roles: [],
						globalRoles: [],
					},
				]),
			);
			expect(listed).toHaveLength(2);
		}),
	);
});

describe("replaceKey", () => {
	test(
		"replaces the old key with the new one and reports the name",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const { serviceAccountId: id, accountId } = yield* createBot(
				"scoreboard",
				"hash-1",
			);

			const replaced = yield* repository.replaceKey(id, {
				hash: "hash-2",
				label: "",
			});

			expect(replaced).toStrictEqual(
				Option.some({ accountId, displayName: "scoreboard" }),
			);
			const old = yield* repository.resolveByKeyHash("hash-1");
			expect(old).toStrictEqual(Option.none());
			const current = yield* repository.resolveByKeyHash("hash-2");
			assert(Option.isSome(current));
			expect(current.value.id).toBe(id);
		}),
	);

	test(
		"reports nothing and stores no key for an unknown id",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;

			const replaced = yield* repository.replaceKey(ghost, {
				hash: "hash-1",
				label: "",
			});

			expect(replaced).toStrictEqual(Option.none());
			const byKey = yield* repository.resolveByKeyHash("hash-1");
			expect(byKey).toStrictEqual(Option.none());
		}),
	);
});

describe("delete", () => {
	test(
		"removes the service account with its key and role grants",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const roleRepository = yield* RoleRepositoryService;
			const { serviceAccountId: id, accountId } = yield* createBot(
				"scoreboard",
				"hash-1",
			);
			yield* repository.grantRole(id, viewer);

			const found = yield* repository.delete(id);

			expect(found).toBe(true);
			const listed = yield* repository.listAll();
			expect(listed).toStrictEqual([]);
			const byKey = yield* repository.resolveByKeyHash("hash-1");
			expect(byKey).toStrictEqual(Option.none());
			const grants = yield* roleRepository.read(accountId);
			expect(grants).toStrictEqual({ roles: [], globalRoles: [] });
		}),
	);

	test(
		"reports an unknown id",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			yield* createBot("scoreboard", "hash-1");

			const found = yield* repository.delete(ghost);

			expect(found).toBe(false);
			const listed = yield* repository.listAll();
			expect(listed).toHaveLength(1);
		}),
	);

	test(
		"keeps a service account whose creator is deleted",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const { serviceAccountId: provisioner, accountId: provisionerAccount } =
				yield* createBot("provisioner", "hash-1");
			const { serviceAccountId } = yield* repository.create({
				displayName: "scoreboard",
				createdBy: provisionerAccount,
			});

			yield* repository.delete(provisioner);

			const rows = yield* createdBy(serviceAccountId);
			expect(rows).toStrictEqual([{ createdBy: null }]);
		}),
	);
});

describe("grantRole", () => {
	test(
		"grants the role to the service account's account, also when already held",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const roleRepository = yield* RoleRepositoryService;
			const { serviceAccountId: id, accountId } = yield* createBot(
				"scoreboard",
				"hash-1",
			);

			const first = yield* repository.grantRole(id, viewer);
			const again = yield* repository.grantRole(id, viewer);

			expect([first, again]).toStrictEqual([true, true]);
			const grants = yield* roleRepository.read(accountId);
			expect(grants.roles).toStrictEqual([viewer]);
		}),
	);

	test(
		"reports an unknown id",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;

			const found = yield* repository.grantRole(ghost, viewer);

			expect(found).toBe(false);
		}),
	);
});

describe("revokeRole", () => {
	test(
		"revokes the role, also when not held",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const roleRepository = yield* RoleRepositoryService;
			const { serviceAccountId: id, accountId } = yield* createBot(
				"scoreboard",
				"hash-1",
			);
			yield* repository.grantRole(id, viewer);

			const first = yield* repository.revokeRole(id, viewer);
			const again = yield* repository.revokeRole(id, viewer);

			expect([first, again]).toStrictEqual([true, true]);
			const grants = yield* roleRepository.read(accountId);
			expect(grants.roles).toStrictEqual([]);
		}),
	);

	test(
		"reports an unknown id",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;

			const found = yield* repository.revokeRole(ghost, viewer);

			expect(found).toBe(false);
		}),
	);
});
