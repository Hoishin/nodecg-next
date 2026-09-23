import { RoleName } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { InMemoryRoleStore } from "./in-memory-role-store.ts";
import { RoleStoreService } from "./role-store.ts";

const test = testLayer(InMemoryRoleStore);

const alice = { issuer: "https://idp.test", subject: "alice" };
const bob = { issuer: "https://idp.test", subject: "bob" };
const aliceElsewhere = { issuer: "https://other.test", subject: "alice" };

const producer = { namespace: "show", name: RoleName("producer") };
const viewer = { namespace: "show", name: RoleName("viewer") };

describe("get", () => {
	test(
		"returns empty grants for an unassigned identity",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.get(alice)).toEqual({
				roles: [],
				globalRoles: [],
			});
		}),
	);
});

describe("list", () => {
	test(
		"returns every assignment with its identity key",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantRole(alice, producer);
			yield* roles.grantRole(alice, viewer);
			yield* roles.grantGlobalRole(bob, "admin");
			const assignments = yield* roles.list;
			expect(assignments).toHaveLength(2);
			expect(assignments).toEqual(
				expect.arrayContaining([
					{
						key: alice,
						roles: [producer, viewer],
						globalRoles: [],
					},
					{
						key: bob,
						roles: [],
						globalRoles: ["admin"],
					},
				]),
			);
		}),
	);

	test(
		"is empty initially",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.list).toEqual([]);
		}),
	);
});

describe("setRoles", () => {
	test(
		"replaces the identity's whole role set",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantRole(alice, producer);
			yield* roles.setRoles(alice, [viewer]);
			expect(yield* roles.get(alice)).toEqual({
				roles: [viewer],
				globalRoles: [],
			});
		}),
	);

	test(
		"keeps a repeated role once",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.setRoles(alice, [viewer, producer, viewer]);
			expect(yield* roles.get(alice)).toEqual({
				roles: [viewer, producer],
				globalRoles: [],
			});
		}),
	);

	test(
		"leaves the identity's global roles untouched",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantGlobalRole(alice, "superadmin");
			yield* roles.setRoles(alice, []);
			expect(yield* roles.get(alice)).toEqual({
				roles: [],
				globalRoles: ["superadmin"],
			});
		}),
	);

	test(
		"leaves other identities alone",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantRole(bob, viewer);
			yield* roles.setRoles(alice, [producer]);
			expect(yield* roles.get(bob)).toEqual({
				roles: [viewer],
				globalRoles: [],
			});
		}),
	);
});

describe("grantRole", () => {
	test(
		"adds a role and returns the resulting roles",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.grantRole(alice, producer)).toEqual([producer]);
			expect(yield* roles.get(alice)).toEqual({
				roles: [producer],
				globalRoles: [],
			});
		}),
	);

	test(
		"accumulates multiple roles and is idempotent per role",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantRole(alice, producer);
			yield* roles.grantRole(alice, producer);
			expect(yield* roles.grantRole(alice, viewer)).toEqual([producer, viewer]);
		}),
	);

	test(
		"holds one name granted in two namespaces as two roles",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			const stageProducer = { namespace: "stage", name: RoleName("producer") };
			yield* roles.grantRole(alice, producer);
			expect(yield* roles.grantRole(alice, stageProducer)).toEqual([
				producer,
				stageProducer,
			]);
		}),
	);

	test(
		"keeps assignments isolated by issuer-qualified subject",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantRole(alice, producer);
			const empty = {
				roles: [],
				globalRoles: [],
			};
			expect(yield* roles.get(bob)).toEqual(empty);
			expect(yield* roles.get(aliceElsewhere)).toEqual(empty);
		}),
	);
});

describe("revokeRole", () => {
	test(
		"removes a granted role and leaves the rest",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantRole(alice, producer);
			yield* roles.grantRole(alice, viewer);
			expect(yield* roles.revokeRole(alice, viewer)).toEqual([producer]);
			expect(yield* roles.get(alice)).toEqual({
				roles: [producer],
				globalRoles: [],
			});
		}),
	);

	test(
		"revoking from an unassigned identity is a no-op",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.revokeRole(alice, producer)).toEqual([]);
		}),
	);
});

describe("setGlobalRoles", () => {
	test(
		"replaces the identity's whole global role list and leaves its roles",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantRole(alice, producer);
			yield* roles.grantGlobalRole(alice, "admin");
			yield* roles.setGlobalRoles(alice, ["superadmin"]);
			expect(yield* roles.get(alice)).toEqual({
				roles: [producer],
				globalRoles: ["superadmin"],
			});
		}),
	);
});

describe("grantGlobalRole", () => {
	test(
		"adds a global role and returns the resulting roles",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantGlobalRole(alice, "admin");
			expect(yield* roles.grantGlobalRole(alice, "superadmin")).toEqual([
				"admin",
				"superadmin",
			]);
			expect(yield* roles.get(alice)).toEqual({
				roles: [],
				globalRoles: ["admin", "superadmin"],
			});
		}),
	);
});

describe("revokeGlobalRole", () => {
	test(
		"removes a granted global role and leaves the rest",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantGlobalRole(alice, "admin");
			yield* roles.grantGlobalRole(alice, "superadmin");
			expect(yield* roles.revokeGlobalRole(alice, "admin")).toEqual([
				"superadmin",
			]);
			expect(yield* roles.get(alice)).toEqual({
				roles: [],
				globalRoles: ["superadmin"],
			});
		}),
	);

	test(
		"revoking from an unassigned identity is a no-op",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.revokeGlobalRole(alice, "admin")).toEqual([]);
		}),
	);
});
