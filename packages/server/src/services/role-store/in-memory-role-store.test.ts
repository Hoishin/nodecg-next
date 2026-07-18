import { ADMIN_ROLE } from "@nodecg/internal";
import { testEffect } from "@nodecg/internal/test-utils";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { InMemoryRoleStore } from "./in-memory-role-store.ts";
import { RoleStoreService } from "./role-store.ts";

const alice = { issuer: "https://idp.test", subject: "alice" };
const bob = { issuer: "https://idp.test", subject: "bob" };
const aliceElsewhere = { issuer: "https://other.test", subject: "alice" };

describe("get", () => {
	test(
		"returns an empty set for an unassigned identity",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				expect(yield* roles.get(alice)).toEqual(new Set());
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);
});

describe("list", () => {
	test(
		"returns every assignment with its identity key",
		testEffect(
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
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);

	test(
		"is empty initially and after the last role is revoked",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				expect(yield* roles.list()).toEqual([]);
				yield* roles.grant(alice, ADMIN_ROLE.superadmin);
				yield* roles.revoke(alice, ADMIN_ROLE.superadmin);
				expect(yield* roles.list()).toEqual([]);
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);
});

describe("set", () => {
	test(
		"replaces the identity's whole role set",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				yield* roles.grant(alice, ADMIN_ROLE.superadmin);
				yield* roles.set(alice, new Set([ADMIN_ROLE.admin]));
				expect(yield* roles.get(alice)).toEqual(new Set([ADMIN_ROLE.admin]));
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);

	test(
		"an empty set clears the identity from the listing",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				yield* roles.grant(alice, ADMIN_ROLE.superadmin);
				yield* roles.set(alice, new Set());
				expect(yield* roles.get(alice)).toEqual(new Set());
				expect(yield* roles.list()).toEqual([]);
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);

	test(
		"leaves other identities alone",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				yield* roles.grant(bob, ADMIN_ROLE.admin);
				yield* roles.set(alice, new Set([ADMIN_ROLE.superadmin]));
				expect(yield* roles.get(bob)).toEqual(new Set([ADMIN_ROLE.admin]));
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);
});

describe("grant", () => {
	test(
		"adds a role and returns the resulting set",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				const result = yield* roles.grant(alice, ADMIN_ROLE.superadmin);
				expect(result).toEqual(new Set([ADMIN_ROLE.superadmin]));
				expect(yield* roles.get(alice)).toEqual(
					new Set([ADMIN_ROLE.superadmin]),
				);
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);

	test(
		"accumulates multiple roles and is idempotent per role",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				yield* roles.grant(alice, ADMIN_ROLE.superadmin);
				yield* roles.grant(alice, ADMIN_ROLE.superadmin);
				const result = yield* roles.grant(alice, ADMIN_ROLE.admin);
				expect(result).toEqual(
					new Set([ADMIN_ROLE.superadmin, ADMIN_ROLE.admin]),
				);
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);

	test(
		"keeps assignments isolated by issuer-qualified subject",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				yield* roles.grant(alice, ADMIN_ROLE.superadmin);
				expect(yield* roles.get(bob)).toEqual(new Set());
				expect(yield* roles.get(aliceElsewhere)).toEqual(new Set());
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);
});

describe("revoke", () => {
	test(
		"removes a granted role and leaves the rest",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				yield* roles.grant(alice, ADMIN_ROLE.superadmin);
				yield* roles.grant(alice, ADMIN_ROLE.admin);
				const result = yield* roles.revoke(alice, ADMIN_ROLE.admin);
				expect(result).toEqual(new Set([ADMIN_ROLE.superadmin]));
				expect(yield* roles.get(alice)).toEqual(
					new Set([ADMIN_ROLE.superadmin]),
				);
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);

	test(
		"revoking the last role clears the identity back to empty",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				yield* roles.grant(alice, ADMIN_ROLE.superadmin);
				expect(yield* roles.revoke(alice, ADMIN_ROLE.superadmin)).toEqual(
					new Set(),
				);
				expect(yield* roles.get(alice)).toEqual(new Set());
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);

	test(
		"revoking from an unassigned identity is a no-op",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				expect(yield* roles.revoke(alice, ADMIN_ROLE.superadmin)).toEqual(
					new Set(),
				);
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);
});
