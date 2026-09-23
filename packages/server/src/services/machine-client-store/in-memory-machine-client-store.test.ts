import { RoleName } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect, Option, Redacted } from "effect";
import { assert, describe, expect } from "vitest";

import { InMemoryMachineClientStore } from "./in-memory-machine-client-store.ts";
import { MachineClientStoreService } from "./machine-client-store.ts";

const test = testLayer(InMemoryMachineClientStore);

const viewer = { namespace: "show", name: RoleName("viewer") };
const judge = { namespace: "show", name: RoleName("judge") };

describe("createApiKey", () => {
	test(
		"returns an ncg-prefixed token and a distinct id per key",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const a = yield* machines.createApiKey({ displayName: "Bot A" });
			const b = yield* machines.createApiKey({ displayName: "Bot B" });
			expect(Redacted.value(a.token)).toMatch(/^ncg_/);
			expect(a.id).not.toBe(b.id);
			expect(Redacted.value(a.token)).not.toBe(Redacted.value(b.token));
		}),
	);
});

describe("validateApiKey", () => {
	test(
		"resolves a created token to its client",
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
				roles: [],
				globalRoles: [],
			});
		}),
	);

	test(
		"returns None for an unknown token",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			expect(Option.isNone(yield* machines.validateApiKey("ncg_ghost"))).toBe(
				true,
			);
		}),
	);
});

describe("list", () => {
	test(
		"returns every created client without its token",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const a = yield* machines.createApiKey({ displayName: "Bot A" });
			const b = yield* machines.createApiKey({ displayName: "Bot B" });
			const clients = yield* machines.list;
			expect(clients).toHaveLength(2);
			expect(clients).toEqual(
				expect.arrayContaining([
					{
						id: a.id,
						displayName: "Bot A",
						roles: [],
						globalRoles: [],
					},
					{
						id: b.id,
						displayName: "Bot B",
						roles: [],
						globalRoles: [],
					},
				]),
			);
		}),
	);

	test(
		"is empty before any key is created",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			expect(yield* machines.list).toEqual([]);
		}),
	);
});

describe("revoke", () => {
	test(
		"removes the client and stops its token validating",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			const revoked = yield* machines.revoke(created.id);
			assert(Option.isSome(revoked));
			expect(revoked.value).toEqual({
				id: created.id,
				displayName: "Bot",
				roles: [],
				globalRoles: [],
			});
			expect(
				Option.isNone(
					yield* machines.validateApiKey(Redacted.value(created.token)),
				),
			).toBe(true);
			expect(yield* machines.list).toEqual([]);
		}),
	);

	test(
		"leaves other clients intact",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const a = yield* machines.createApiKey({ displayName: "Bot A" });
			const b = yield* machines.createApiKey({ displayName: "Bot B" });
			yield* machines.revoke(a.id);
			const resolved = yield* machines.validateApiKey(Redacted.value(b.token));
			assert(Option.isSome(resolved));
			expect(resolved.value).toEqual({
				id: b.id,
				displayName: "Bot B",
				roles: [],
				globalRoles: [],
			});
		}),
	);

	test(
		"returns None for an unknown id",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			expect(Option.isNone(yield* machines.revoke("ghost"))).toBe(true);
		}),
	);
});

describe("refreshApiKey", () => {
	test(
		"rotates the token while keeping id and display name",
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
		}),
	);

	test(
		"validates the new token and stops validating the old one",
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
				roles: [],
				globalRoles: [],
			});
			expect(
				Option.isNone(
					yield* machines.validateApiKey(Redacted.value(created.token)),
				),
			).toBe(true);
		}),
	);

	test(
		"does not add or remove a listing entry",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			yield* machines.refreshApiKey(created.id);
			expect(yield* machines.list).toEqual([
				{
					id: created.id,
					displayName: "Bot",
					roles: [],
					globalRoles: [],
				},
			]);
		}),
	);

	test(
		"returns None for an unknown id",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			expect(Option.isNone(yield* machines.refreshApiKey("ghost"))).toBe(true);
		}),
	);
});

describe("setRoles", () => {
	test(
		"replaces the whole list and surfaces it on the client",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			yield* machines.grantRole(created.id, viewer);
			const result = yield* machines.setRoles(created.id, [judge]);
			assert(Option.isSome(result));
			expect(result.value).toEqual([judge]);
			const resolved = yield* machines.validateApiKey(
				Redacted.value(created.token),
			);
			assert(Option.isSome(resolved));
			expect(resolved.value.roles).toEqual([judge]);
		}),
	);

	test(
		"keeps a repeated role once",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			const result = yield* machines.setRoles(created.id, [
				viewer,
				judge,
				viewer,
			]);
			assert(Option.isSome(result));
			expect(result.value).toEqual([viewer, judge]);
		}),
	);

	test(
		"an empty set clears every role",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			yield* machines.grantRole(created.id, viewer);
			const result = yield* machines.setRoles(created.id, []);
			assert(Option.isSome(result));
			expect(result.value).toEqual([]);
		}),
	);

	test(
		"leaves the client's global roles untouched",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			yield* machines.grantGlobalRole(created.id, "admin");
			yield* machines.setRoles(created.id, []);
			const resolved = yield* machines.validateApiKey(
				Redacted.value(created.token),
			);
			assert(Option.isSome(resolved));
			expect(resolved.value.globalRoles).toEqual(["admin"]);
		}),
	);

	test(
		"returns None for an unknown id",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			expect(yield* machines.setRoles("ghost", [viewer])).toEqual(
				Option.none(),
			);
		}),
	);
});

describe("grantRole / revokeRole", () => {
	test(
		"accumulates granted roles and surfaces them on the client",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			const afterFirst = yield* machines.grantRole(created.id, viewer);
			assert(Option.isSome(afterFirst));
			expect(afterFirst.value).toEqual([viewer]);
			yield* machines.grantRole(created.id, judge);
			const resolved = yield* machines.validateApiKey(
				Redacted.value(created.token),
			);
			assert(Option.isSome(resolved));
			expect(resolved.value.roles).toEqual(
				expect.arrayContaining([viewer, judge]),
			);
			expect(resolved.value.roles).toHaveLength(2);
		}),
	);

	test(
		"granting the same role twice is idempotent",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			yield* machines.grantRole(created.id, viewer);
			const again = yield* machines.grantRole(created.id, viewer);
			assert(Option.isSome(again));
			expect(again.value).toEqual([viewer]);
		}),
	);

	test(
		"holds one name granted in two namespaces as two roles",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			const stageViewer = { namespace: "stage", name: RoleName("viewer") };
			yield* machines.grantRole(created.id, viewer);
			const both = yield* machines.grantRole(created.id, stageViewer);
			assert(Option.isSome(both));
			expect(both.value).toEqual([viewer, stageViewer]);
		}),
	);

	test(
		"revoking a role removes only that role",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			yield* machines.grantRole(created.id, viewer);
			yield* machines.grantRole(created.id, judge);
			const remaining = yield* machines.revokeRole(created.id, viewer);
			assert(Option.isSome(remaining));
			expect(remaining.value).toEqual([judge]);
		}),
	);

	test(
		"revoking a role the machine lacks is a no-op",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			const remaining = yield* machines.revokeRole(created.id, viewer);
			assert(Option.isSome(remaining));
			expect(remaining.value).toEqual([]);
		}),
	);

	test(
		"return None for an unknown id",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			expect(Option.isNone(yield* machines.grantRole("ghost", viewer))).toBe(
				true,
			);
			expect(Option.isNone(yield* machines.revokeRole("ghost", viewer))).toBe(
				true,
			);
		}),
	);
});

describe("setGlobalRoles", () => {
	test(
		"replaces the whole global list and leaves the client's roles",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			yield* machines.grantRole(created.id, viewer);
			yield* machines.grantGlobalRole(created.id, "admin");
			const result = yield* machines.setGlobalRoles(created.id, ["superadmin"]);
			assert(Option.isSome(result));
			expect(result.value).toEqual(["superadmin"]);
			const resolved = yield* machines.validateApiKey(
				Redacted.value(created.token),
			);
			assert(Option.isSome(resolved));
			expect(resolved.value).toEqual({
				id: created.id,
				displayName: "Bot",
				roles: [viewer],
				globalRoles: ["superadmin"],
			});
		}),
	);

	test(
		"returns None for an unknown id",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			expect(yield* machines.setGlobalRoles("ghost", ["admin"])).toEqual(
				Option.none(),
			);
		}),
	);
});

describe("grantGlobalRole / revokeGlobalRole", () => {
	test(
		"grants and revokes a global role on the client",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			const created = yield* machines.createApiKey({ displayName: "Bot" });
			const granted = yield* machines.grantGlobalRole(created.id, "admin");
			assert(Option.isSome(granted));
			expect(granted.value).toEqual(["admin"]);
			const revoked = yield* machines.revokeGlobalRole(created.id, "admin");
			assert(Option.isSome(revoked));
			expect(revoked.value).toEqual([]);
			const resolved = yield* machines.validateApiKey(
				Redacted.value(created.token),
			);
			assert(Option.isSome(resolved));
			expect(resolved.value).toEqual({
				id: created.id,
				displayName: "Bot",
				roles: [],
				globalRoles: [],
			});
		}),
	);

	test(
		"return None for an unknown id",
		Effect.gen(function* () {
			const machines = yield* MachineClientStoreService;
			expect(
				Option.isNone(yield* machines.grantGlobalRole("ghost", "admin")),
			).toBe(true);
			expect(
				Option.isNone(yield* machines.revokeGlobalRole("ghost", "admin")),
			).toBe(true);
		}),
	);
});
