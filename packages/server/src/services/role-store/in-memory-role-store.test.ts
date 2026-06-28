import { RESERVED_ROLE } from "@nodecg/internal";
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

describe("grant", () => {
	test(
		"adds a role and returns the resulting set",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				const result = yield* roles.grant(alice, RESERVED_ROLE.superadmin);
				expect(result).toEqual(new Set([RESERVED_ROLE.superadmin]));
				expect(yield* roles.get(alice)).toEqual(
					new Set([RESERVED_ROLE.superadmin]),
				);
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);

	test(
		"accumulates multiple roles and is idempotent per role",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				yield* roles.grant(alice, RESERVED_ROLE.superadmin);
				yield* roles.grant(alice, RESERVED_ROLE.superadmin);
				const result = yield* roles.grant(alice, RESERVED_ROLE.admin);
				expect(result).toEqual(
					new Set([RESERVED_ROLE.superadmin, RESERVED_ROLE.admin]),
				);
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);

	test(
		"keeps assignments isolated by issuer-qualified subject",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				yield* roles.grant(alice, RESERVED_ROLE.superadmin);
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
				yield* roles.grant(alice, RESERVED_ROLE.superadmin);
				yield* roles.grant(alice, RESERVED_ROLE.admin);
				const result = yield* roles.revoke(alice, RESERVED_ROLE.admin);
				expect(result).toEqual(new Set([RESERVED_ROLE.superadmin]));
				expect(yield* roles.get(alice)).toEqual(
					new Set([RESERVED_ROLE.superadmin]),
				);
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);

	test(
		"revoking the last role clears the identity back to empty",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				yield* roles.grant(alice, RESERVED_ROLE.superadmin);
				expect(yield* roles.revoke(alice, RESERVED_ROLE.superadmin)).toEqual(
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
				expect(yield* roles.revoke(alice, RESERVED_ROLE.superadmin)).toEqual(
					new Set(),
				);
			}).pipe(Effect.provide(InMemoryRoleStore)),
		),
	);
});
