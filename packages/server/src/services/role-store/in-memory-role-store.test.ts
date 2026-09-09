import { ADMIN_ROLE } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { InMemoryRoleStore } from "./in-memory-role-store.ts";
import { RoleStoreService } from "./role-store.ts";

const test = testLayer(InMemoryRoleStore);

const alice = { issuer: "https://idp.test", subject: "alice" };
const bob = { issuer: "https://idp.test", subject: "bob" };
const aliceElsewhere = { issuer: "https://other.test", subject: "alice" };

describe("get", () => {
	test(
		"returns an empty set for an unassigned identity",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.get(alice)).toEqual(new Set());
		}),
	);
});

describe("list", () => {
	test(
		"returns every assignment with its identity key",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, ADMIN_ROLE.superadmin);
			yield* roles.grant(alice, ADMIN_ROLE.admin);
			yield* roles.grant(bob, ADMIN_ROLE.admin);
			const assignments = yield* roles.list();
			expect(assignments).toHaveLength(2);
			expect(assignments).toEqual(
				expect.arrayContaining([
					{
						key: alice,
						roles: new Set([ADMIN_ROLE.superadmin, ADMIN_ROLE.admin]),
					},
					{ key: bob, roles: new Set([ADMIN_ROLE.admin]) },
				]),
			);
		}),
	);

	test(
		"is empty initially and after the last role is revoked",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.list()).toEqual([]);
			yield* roles.grant(alice, ADMIN_ROLE.superadmin);
			yield* roles.revoke(alice, ADMIN_ROLE.superadmin);
			expect(yield* roles.list()).toEqual([]);
		}),
	);
});

describe("set", () => {
	test(
		"replaces the identity's whole role set",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, ADMIN_ROLE.superadmin);
			yield* roles.set(alice, new Set([ADMIN_ROLE.admin]));
			expect(yield* roles.get(alice)).toEqual(new Set([ADMIN_ROLE.admin]));
		}),
	);

	test(
		"an empty set clears the identity from the listing",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, ADMIN_ROLE.superadmin);
			yield* roles.set(alice, new Set());
			expect(yield* roles.get(alice)).toEqual(new Set());
			expect(yield* roles.list()).toEqual([]);
		}),
	);

	test(
		"leaves other identities alone",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(bob, ADMIN_ROLE.admin);
			yield* roles.set(alice, new Set([ADMIN_ROLE.superadmin]));
			expect(yield* roles.get(bob)).toEqual(new Set([ADMIN_ROLE.admin]));
		}),
	);
});

describe("grant", () => {
	test(
		"adds a role and returns the resulting set",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			const result = yield* roles.grant(alice, ADMIN_ROLE.superadmin);
			expect(result).toEqual(new Set([ADMIN_ROLE.superadmin]));
			expect(yield* roles.get(alice)).toEqual(new Set([ADMIN_ROLE.superadmin]));
		}),
	);

	test(
		"accumulates multiple roles and is idempotent per role",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, ADMIN_ROLE.superadmin);
			yield* roles.grant(alice, ADMIN_ROLE.superadmin);
			const result = yield* roles.grant(alice, ADMIN_ROLE.admin);
			expect(result).toEqual(
				new Set([ADMIN_ROLE.superadmin, ADMIN_ROLE.admin]),
			);
		}),
	);

	test(
		"keeps assignments isolated by issuer-qualified subject",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, ADMIN_ROLE.superadmin);
			expect(yield* roles.get(bob)).toEqual(new Set());
			expect(yield* roles.get(aliceElsewhere)).toEqual(new Set());
		}),
	);
});

describe("revoke", () => {
	test(
		"removes a granted role and leaves the rest",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, ADMIN_ROLE.superadmin);
			yield* roles.grant(alice, ADMIN_ROLE.admin);
			const result = yield* roles.revoke(alice, ADMIN_ROLE.admin);
			expect(result).toEqual(new Set([ADMIN_ROLE.superadmin]));
			expect(yield* roles.get(alice)).toEqual(new Set([ADMIN_ROLE.superadmin]));
		}),
	);

	test(
		"revoking the last role clears the identity back to empty",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			yield* roles.grant(alice, ADMIN_ROLE.superadmin);
			expect(yield* roles.revoke(alice, ADMIN_ROLE.superadmin)).toEqual(
				new Set(),
			);
			expect(yield* roles.get(alice)).toEqual(new Set());
		}),
	);

	test(
		"revoking from an unassigned identity is a no-op",
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.revoke(alice, ADMIN_ROLE.superadmin)).toEqual(
				new Set(),
			);
		}),
	);
});
