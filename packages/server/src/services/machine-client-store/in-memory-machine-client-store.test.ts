import { RoleName } from "@nodecg/internal";
import { testEffect } from "@nodecg/internal/test-utils";
import { Effect, Option, Redacted } from "effect";
import { assert, describe, expect, test } from "vitest";

import { InMemoryMachineClientStore } from "./in-memory-machine-client-store.ts";
import { MachineClientStoreService } from "./machine-client-store.ts";

describe("createApiKey", () => {
	test(
		"returns an ncg-prefixed token and a distinct id per key",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const a = yield* machines.createApiKey({ displayName: "Bot A" });
				const b = yield* machines.createApiKey({ displayName: "Bot B" });
				expect(Redacted.value(a.token)).toMatch(/^ncg_/);
				expect(a.id).not.toBe(b.id);
				expect(Redacted.value(a.token)).not.toBe(Redacted.value(b.token));
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);
});

describe("validateApiKey", () => {
	test(
		"resolves a created token to its client",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const created = yield* machines.createApiKey({ displayName: "Bot" });
				const resolved = yield* machines.validateApiKey(
					Redacted.value(created.token),
				);
				assert(Option.isSome(resolved));
				expect(resolved.value).toEqual({
					id: created.id,
					displayName: "Bot",
					roles: new Set(),
				});
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);

	test(
		"returns None for an unknown token",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				expect(Option.isNone(yield* machines.validateApiKey("ncg_ghost"))).toBe(
					true,
				);
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);
});

describe("list", () => {
	test(
		"returns every created client without its token",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const a = yield* machines.createApiKey({ displayName: "Bot A" });
				const b = yield* machines.createApiKey({ displayName: "Bot B" });
				const clients = yield* machines.list();
				expect(clients).toHaveLength(2);
				expect(clients).toEqual(
					expect.arrayContaining([
						{ id: a.id, displayName: "Bot A", roles: new Set() },
						{ id: b.id, displayName: "Bot B", roles: new Set() },
					]),
				);
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);

	test(
		"is empty before any key is created",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				expect(yield* machines.list()).toEqual([]);
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);
});

describe("revoke", () => {
	test(
		"removes the client and stops its token validating",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const created = yield* machines.createApiKey({ displayName: "Bot" });
				const revoked = yield* machines.revoke(created.id);
				assert(Option.isSome(revoked));
				expect(revoked.value).toEqual({
					id: created.id,
					displayName: "Bot",
					roles: new Set(),
				});
				expect(
					Option.isNone(
						yield* machines.validateApiKey(Redacted.value(created.token)),
					),
				).toBe(true);
				expect(yield* machines.list()).toEqual([]);
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);

	test(
		"leaves other clients intact",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const a = yield* machines.createApiKey({ displayName: "Bot A" });
				const b = yield* machines.createApiKey({ displayName: "Bot B" });
				yield* machines.revoke(a.id);
				const resolved = yield* machines.validateApiKey(
					Redacted.value(b.token),
				);
				assert(Option.isSome(resolved));
				expect(resolved.value).toEqual({
					id: b.id,
					displayName: "Bot B",
					roles: new Set(),
				});
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);

	test(
		"returns None for an unknown id",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				expect(Option.isNone(yield* machines.revoke("ghost"))).toBe(true);
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);
});

describe("refreshApiKey", () => {
	test(
		"rotates the token while keeping id and display name",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const created = yield* machines.createApiKey({ displayName: "Bot" });
				const refreshed = yield* machines.refreshApiKey(created.id);
				assert(Option.isSome(refreshed));
				expect(refreshed.value.id).toBe(created.id);
				expect(refreshed.value.displayName).toBe("Bot");
				expect(Redacted.value(refreshed.value.token)).toMatch(/^ncg_/);
				expect(Redacted.value(refreshed.value.token)).not.toBe(
					Redacted.value(created.token),
				);
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);

	test(
		"validates the new token and stops validating the old one",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const created = yield* machines.createApiKey({ displayName: "Bot" });
				const refreshed = yield* machines.refreshApiKey(created.id);
				assert(Option.isSome(refreshed));
				const byNew = yield* machines.validateApiKey(
					Redacted.value(refreshed.value.token),
				);
				assert(Option.isSome(byNew));
				expect(byNew.value).toEqual({
					id: created.id,
					displayName: "Bot",
					roles: new Set(),
				});
				expect(
					Option.isNone(
						yield* machines.validateApiKey(Redacted.value(created.token)),
					),
				).toBe(true);
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);

	test(
		"does not add or remove a listing entry",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const created = yield* machines.createApiKey({ displayName: "Bot" });
				yield* machines.refreshApiKey(created.id);
				expect(yield* machines.list()).toEqual([
					{ id: created.id, displayName: "Bot", roles: new Set() },
				]);
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);

	test(
		"returns None for an unknown id",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				expect(Option.isNone(yield* machines.refreshApiKey("ghost"))).toBe(
					true,
				);
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);
});

describe("grantRole / revokeRole", () => {
	test(
		"accumulates granted roles and surfaces them on the client",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const created = yield* machines.createApiKey({ displayName: "Bot" });
				const afterFirst = yield* machines.grantRole(
					created.id,
					RoleName("viewer"),
				);
				assert(Option.isSome(afterFirst));
				expect(afterFirst.value).toEqual(new Set([RoleName("viewer")]));
				yield* machines.grantRole(created.id, RoleName("judge"));
				const resolved = yield* machines.validateApiKey(
					Redacted.value(created.token),
				);
				assert(Option.isSome(resolved));
				expect(resolved.value.roles).toEqual(
					new Set([RoleName("viewer"), RoleName("judge")]),
				);
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);

	test(
		"granting the same role twice is idempotent",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const created = yield* machines.createApiKey({ displayName: "Bot" });
				yield* machines.grantRole(created.id, RoleName("viewer"));
				const again = yield* machines.grantRole(created.id, RoleName("viewer"));
				assert(Option.isSome(again));
				expect(again.value).toEqual(new Set([RoleName("viewer")]));
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);

	test(
		"revoking a role removes only that role",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const created = yield* machines.createApiKey({ displayName: "Bot" });
				yield* machines.grantRole(created.id, RoleName("viewer"));
				yield* machines.grantRole(created.id, RoleName("judge"));
				const remaining = yield* machines.revokeRole(
					created.id,
					RoleName("viewer"),
				);
				assert(Option.isSome(remaining));
				expect(remaining.value).toEqual(new Set([RoleName("judge")]));
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);

	test(
		"revoking a role the machine lacks is a no-op",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				const created = yield* machines.createApiKey({ displayName: "Bot" });
				const remaining = yield* machines.revokeRole(
					created.id,
					RoleName("viewer"),
				);
				assert(Option.isSome(remaining));
				expect(remaining.value).toEqual(new Set());
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);

	test(
		"return None for an unknown id",
		testEffect(
			Effect.gen(function* () {
				const machines = yield* MachineClientStoreService;
				expect(
					Option.isNone(yield* machines.grantRole("ghost", RoleName("viewer"))),
				).toBe(true);
				expect(
					Option.isNone(yield* machines.revokeRole("ghost", RoleName("viewer"))),
				).toBe(true);
			}).pipe(Effect.provide(InMemoryMachineClientStore)),
		),
	);
});
