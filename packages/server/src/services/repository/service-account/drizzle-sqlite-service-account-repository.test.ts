import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { type Role, RoleName, ServiceAccountId } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { assert, describe, expect } from "vitest";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import {
	apiKeys,
	serviceAccounts,
} from "../../database/drizzle-sqlite/tables.ts";
import { DrizzleSqliteRoleRepository } from "../role/drizzle-sqlite-role-repository.ts";
import { RoleRepositoryService } from "../role/role-repository.ts";
import { DrizzleSqliteServiceAccountRepository } from "./drizzle-sqlite-service-account-repository.ts";
import { ServiceAccountRepositoryService } from "./service-account-repository.ts";

const test = testLayer(
	Layer.mergeAll(
		DrizzleSqliteServiceAccountRepository,
		DrizzleSqliteRoleRepository,
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
const ghost = ServiceAccountId.make("ghost");

const createBot = Effect.fn(function* (displayName: string, hash: string) {
	const repository = yield* ServiceAccountRepositoryService;
	const id = yield* repository.create({
		displayName,
		createdBy: Option.none(),
		now: 0,
	});
	yield* repository.addKey(id, { hash, label: "" }, 0);
	return id;
});

const findAccountId = Effect.fn(function* (id: ServiceAccountId) {
	const repository = yield* ServiceAccountRepositoryService;
	const [found] = yield* repository.resolveMany([id]);
	assert(typeof found !== "undefined");
	return found.accountId;
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
			const id = yield* createBot("scoreboard", "hash-1");

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
			const provisioner = yield* createBot("provisioner", "hash-1");
			const provisionerAccount = yield* findAccountId(provisioner);

			const id = yield* repository.create({
				displayName: "scoreboard",
				createdBy: Option.some(provisionerAccount),
				now: 0,
			});

			const rows = yield* createdBy(id);
			expect(rows).toStrictEqual([{ createdBy: provisionerAccount }]);
		}),
	);
});

describe("resolveMany", () => {
	test(
		"resolves the known ids among those asked for",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const scoreboard = yield* createBot("scoreboard", "hash-1");
			const timer = yield* createBot("timer", "hash-2");
			yield* createBot("ignored", "hash-3");

			const resolved = yield* repository.resolveMany([
				scoreboard,
				timer,
				ghost,
			]);

			expect(
				resolved.map(({ id, displayName }) => ({ id, displayName })),
			).toEqual(
				expect.arrayContaining([
					{ id: scoreboard, displayName: "scoreboard" },
					{ id: timer, displayName: "timer" },
				]),
			);
			expect(resolved).toHaveLength(2);
		}),
	);
});

describe("resolveByKeyHash", () => {
	test(
		"resolves a key to its service account",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const id = yield* createBot("scoreboard", "hash-1");
			const accountId = yield* findAccountId(id);

			const byKey = yield* repository.resolveByKeyHash("hash-1", 0);

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

			const resolved = yield* repository.resolveByKeyHash("hash-2", 0);

			expect(resolved).toStrictEqual(Option.none());
		}),
	);

	test(
		"resolves a key until it expires",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;
			const id = yield* createBot("scoreboard", "hash-1");
			yield* db
				.update(apiKeys)
				.set({ expiresAt: 100 })
				.where(eq(apiKeys.serviceAccountId, id));

			const before = yield* repository.resolveByKeyHash("hash-1", 99);
			assert(Option.isSome(before));
			const at = yield* repository.resolveByKeyHash("hash-1", 100);
			expect(at).toStrictEqual(Option.none());
		}),
	);
});

describe("listAll", () => {
	test(
		"lists every service account with its own roles and global roles",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const scoreboard = yield* createBot("scoreboard", "hash-1");
			const timer = yield* createBot("timer", "hash-2");
			yield* repository.grantRole(scoreboard, viewer);
			yield* repository.grantGlobalRole(scoreboard, "admin");

			const listed = yield* repository.listAll();

			expect(listed).toEqual(
				expect.arrayContaining([
					{
						id: scoreboard,
						displayName: "scoreboard",
						roles: [viewer],
						globalRoles: ["admin"],
					},
					{ id: timer, displayName: "timer", roles: [], globalRoles: [] },
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
			const id = yield* createBot("scoreboard", "hash-1");

			const replaced = yield* repository.replaceKey(
				id,
				{ hash: "hash-2", label: "" },
				0,
			);

			expect(replaced).toStrictEqual(
				Option.some({ displayName: "scoreboard" }),
			);
			const old = yield* repository.resolveByKeyHash("hash-1", 0);
			expect(old).toStrictEqual(Option.none());
			const current = yield* repository.resolveByKeyHash("hash-2", 0);
			assert(Option.isSome(current));
			expect(current.value.id).toBe(id);
		}),
	);

	test(
		"reports nothing and stores no key for an unknown id",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;

			const replaced = yield* repository.replaceKey(
				ghost,
				{ hash: "hash-1", label: "" },
				0,
			);

			expect(replaced).toStrictEqual(Option.none());
			const byKey = yield* repository.resolveByKeyHash("hash-1", 0);
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
			const id = yield* createBot("scoreboard", "hash-1");
			const accountId = yield* findAccountId(id);
			yield* repository.grantRole(id, viewer);

			const found = yield* repository.delete(id);

			expect(found).toBe(true);
			const listed = yield* repository.listAll();
			expect(listed).toStrictEqual([]);
			const byKey = yield* repository.resolveByKeyHash("hash-1", 0);
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
			const provisioner = yield* createBot("provisioner", "hash-1");
			const id = yield* repository.create({
				displayName: "scoreboard",
				createdBy: Option.some(yield* findAccountId(provisioner)),
				now: 0,
			});

			yield* repository.delete(provisioner);

			const rows = yield* createdBy(id);
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
			const id = yield* createBot("scoreboard", "hash-1");
			const accountId = yield* findAccountId(id);

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
			const id = yield* createBot("scoreboard", "hash-1");
			const accountId = yield* findAccountId(id);
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

describe("grantGlobalRole", () => {
	test(
		"grants the global role to the service account's account, also when already held",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const roleRepository = yield* RoleRepositoryService;
			const id = yield* createBot("scoreboard", "hash-1");
			const accountId = yield* findAccountId(id);

			const first = yield* repository.grantGlobalRole(id, "admin");
			const again = yield* repository.grantGlobalRole(id, "admin");

			expect([first, again]).toStrictEqual([true, true]);
			const grants = yield* roleRepository.read(accountId);
			expect(grants.globalRoles).toStrictEqual(["admin"]);
		}),
	);

	test(
		"reports an unknown id",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;

			const found = yield* repository.grantGlobalRole(ghost, "admin");

			expect(found).toBe(false);
		}),
	);
});

describe("revokeGlobalRole", () => {
	test(
		"revokes the global role, also when not held",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;
			const roleRepository = yield* RoleRepositoryService;
			const id = yield* createBot("scoreboard", "hash-1");
			const accountId = yield* findAccountId(id);
			yield* repository.grantGlobalRole(id, "admin");

			const first = yield* repository.revokeGlobalRole(id, "admin");
			const again = yield* repository.revokeGlobalRole(id, "admin");

			expect([first, again]).toStrictEqual([true, true]);
			const grants = yield* roleRepository.read(accountId);
			expect(grants.globalRoles).toStrictEqual([]);
		}),
	);

	test(
		"reports an unknown id",
		Effect.gen(function* () {
			const repository = yield* ServiceAccountRepositoryService;

			const found = yield* repository.revokeGlobalRole(ghost, "admin");

			expect(found).toBe(false);
		}),
	);
});
