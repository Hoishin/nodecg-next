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

const producer = RoleName("producer");
const viewer = RoleName("viewer");

describe("get", () => {
	test(
		"returns empty grants for an unassigned identity",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.get(alice)).toEqual({
				roles: new Set(),
				globalRoles: new Set(),
			});
		}),
	);
});

describe("list", () => {
	test(
		"returns every assignment with its identity key",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, producer);
			yield* roles.grant(alice, viewer);
			yield* roles.grantGlobal(bob, "admin");
			const assignments = yield* roles.list;
			expect(assignments).toHaveLength(2);
			expect(assignments).toEqual(
				expect.arrayContaining([
					{
						key: alice,
						roles: new Set([producer, viewer]),
						globalRoles: new Set(),
					},
					{ key: bob, roles: new Set(), globalRoles: new Set(["admin"]) },
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

describe("set", () => {
	test(
		"replaces the identity's whole role set",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, producer);
			yield* roles.set(alice, new Set([viewer]));
			expect(yield* roles.get(alice)).toEqual({
				roles: new Set([viewer]),
				globalRoles: new Set(),
			});
		}),
	);

	test(
		"leaves the identity's global roles untouched",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantGlobal(alice, "superadmin");
			yield* roles.set(alice, new Set());
			expect(yield* roles.get(alice)).toEqual({
				roles: new Set(),
				globalRoles: new Set(["superadmin"]),
			});
		}),
	);

	test(
		"leaves other identities alone",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(bob, viewer);
			yield* roles.set(alice, new Set([producer]));
			expect(yield* roles.get(bob)).toEqual({
				roles: new Set([viewer]),
				globalRoles: new Set(),
			});
		}),
	);
});

describe("grant", () => {
	test(
		"adds a role and returns the resulting set",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.grant(alice, producer)).toEqual(new Set([producer]));
			expect(yield* roles.get(alice)).toEqual({
				roles: new Set([producer]),
				globalRoles: new Set(),
			});
		}),
	);

	test(
		"accumulates multiple roles and is idempotent per role",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, producer);
			yield* roles.grant(alice, producer);
			expect(yield* roles.grant(alice, viewer)).toEqual(
				new Set([producer, viewer]),
			);
		}),
	);

	test(
		"keeps assignments isolated by issuer-qualified subject",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, producer);
			const empty = { roles: new Set(), globalRoles: new Set() };
			expect(yield* roles.get(bob)).toEqual(empty);
			expect(yield* roles.get(aliceElsewhere)).toEqual(empty);
		}),
	);
});

describe("revoke", () => {
	test(
		"removes a granted role and leaves the rest",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, producer);
			yield* roles.grant(alice, viewer);
			expect(yield* roles.revoke(alice, viewer)).toEqual(new Set([producer]));
			expect(yield* roles.get(alice)).toEqual({
				roles: new Set([producer]),
				globalRoles: new Set(),
			});
		}),
	);

	test(
		"revoking from an unassigned identity is a no-op",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.revoke(alice, producer)).toEqual(new Set());
		}),
	);
});

describe("setGlobal", () => {
	test(
		"replaces the identity's whole global role set and leaves its roles",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, producer);
			yield* roles.grantGlobal(alice, "admin");
			yield* roles.setGlobal(alice, new Set(["superadmin"]));
			expect(yield* roles.get(alice)).toEqual({
				roles: new Set([producer]),
				globalRoles: new Set(["superadmin"]),
			});
		}),
	);
});

describe("grantGlobal", () => {
	test(
		"adds a global role and returns the resulting set",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantGlobal(alice, "admin");
			expect(yield* roles.grantGlobal(alice, "superadmin")).toEqual(
				new Set(["admin", "superadmin"]),
			);
			expect(yield* roles.get(alice)).toEqual({
				roles: new Set(),
				globalRoles: new Set(["admin", "superadmin"]),
			});
		}),
	);
});

describe("revokeGlobal", () => {
	test(
		"removes a granted global role and leaves the rest",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grantGlobal(alice, "admin");
			yield* roles.grantGlobal(alice, "superadmin");
			expect(yield* roles.revokeGlobal(alice, "admin")).toEqual(
				new Set(["superadmin"]),
			);
			expect(yield* roles.get(alice)).toEqual({
				roles: new Set(),
				globalRoles: new Set(["superadmin"]),
			});
		}),
	);

	test(
		"revoking from an unassigned identity is a no-op",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.revokeGlobal(alice, "admin")).toEqual(new Set());
		}),
	);
});
