import { AccountId, type Role, RoleName } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import {
	type AccountRepository,
	AccountRepositoryService,
} from "../services/repository/account/account-repository.ts";
import {
	type RoleStore,
	RoleStoreService,
} from "../services/role-store/role-store.ts";
import {
	getRoles,
	grantGlobalRole,
	grantRole,
	superadminExists,
	revokeGlobalRole,
	SuperadminInConfig,
	UnknownAuthentication,
} from "./roles.ts";

const alice = { issuer: "dev", subject: "alice" };
const root = { issuer: "dev", subject: "root" };
const viewer: Role = { namespace: "show", name: RoleName("viewer") };

const resolveByAuthentication = vi.fn<
	AccountRepository["resolveByAuthentication"]
>(() => Effect.succeedSome(AccountId.make("alice-account")));
const storeGet = vi.fn<RoleStore["get"]>(() =>
	Effect.succeed({ roles: [viewer], globalRoles: ["admin"] }),
);
const storeList = vi.fn<() => RoleStore["list"]>(() => Effect.succeed([]));
const storeGrantRole = vi.fn<RoleStore["grantRole"]>(() =>
	Effect.succeed([viewer]),
);
const storeGrantGlobalRole = vi.fn<RoleStore["grantGlobalRole"]>(() =>
	Effect.succeed(["admin"]),
);
const storeRevokeGlobalRole = vi.fn<RoleStore["revokeGlobalRole"]>(() =>
	Effect.succeed([]),
);

afterEach(() => {
	for (const mock of [
		resolveByAuthentication,
		storeGet,
		storeList,
		storeGrantRole,
		storeGrantGlobalRole,
		storeRevokeGlobalRole,
	]) {
		mock.mockReset();
	}
});

const test = testLayer(
	Layer.mergeAll(
		Layer.succeed(AccountRepositoryService, { resolveByAuthentication }),
		Layer.succeed(RoleStoreService, {
			get: storeGet,
			list: Effect.suspend(storeList),
			setRoles: vi.fn(),
			grantRole: storeGrantRole,
			revokeRole: vi.fn(),
			setGlobalRoles: vi.fn(),
			grantGlobalRole: storeGrantGlobalRole,
			revokeGlobalRole: storeRevokeGlobalRole,
		}),
		Layer.succeed(ConfiguredSuperadmins, [root]),
	),
);

describe("getRoles", () => {
	test(
		"adds superadmin for a configured superadmin",
		Effect.gen(function* () {
			expect(yield* getRoles(root)).toStrictEqual({
				roles: [viewer],
				globalRoles: ["admin", "superadmin"],
			});
			expect(storeGet).toHaveBeenCalledExactlyOnceWith(root);
		}),
	);

	test(
		"adds nothing for an authentication not configured as superadmin",
		Effect.gen(function* () {
			expect(yield* getRoles(alice)).toStrictEqual({
				roles: [viewer],
				globalRoles: ["admin"],
			});
		}),
	);
});

describe("superadminExists", () => {
	test(
		"reports a superadmin in config without reading the store",
		Effect.gen(function* () {
			expect(yield* superadminExists()).toBe(true);
			expect(storeList).not.toHaveBeenCalled();
		}),
	);

	test(
		"reports a superadmin granted in the store when none is in config",
		Effect.gen(function* () {
			storeList.mockReturnValueOnce(
				Effect.succeed([
					{ key: alice, roles: [], globalRoles: ["superadmin"] },
				]),
			);
			expect(
				yield* superadminExists().pipe(
					Effect.provideService(ConfiguredSuperadmins, []),
				),
			).toBe(true);
		}),
	);

	test(
		"reports none when neither config nor the store has a superadmin",
		Effect.gen(function* () {
			storeList.mockReturnValueOnce(
				Effect.succeed([{ key: alice, roles: [], globalRoles: ["admin"] }]),
			);
			expect(
				yield* superadminExists().pipe(
					Effect.provideService(ConfiguredSuperadmins, []),
				),
			).toBe(false);
		}),
	);
});

describe("grantRole", () => {
	test(
		"grants the role to an authentication with an account",
		Effect.gen(function* () {
			yield* grantRole(alice, viewer);
			expect(resolveByAuthentication).toHaveBeenCalledExactlyOnceWith(alice);
			expect(storeGrantRole).toHaveBeenCalledExactlyOnceWith(alice, viewer);
		}),
	);

	test(
		"fails with UnknownAuthentication and grants nothing without an account",
		Effect.gen(function* () {
			resolveByAuthentication.mockReturnValueOnce(Effect.succeedNone);
			const error = yield* grantRole(alice, viewer).pipe(Effect.flip);
			expect(error).toStrictEqual(
				UnknownAuthentication.make({ issuer: "dev", subject: "alice" }),
			);
			expect(storeGrantRole).not.toHaveBeenCalled();
		}),
	);
});

describe("grantGlobalRole", () => {
	test(
		"grants the global role to an authentication with an account",
		Effect.gen(function* () {
			yield* grantGlobalRole(alice, "admin");
			expect(resolveByAuthentication).toHaveBeenCalledExactlyOnceWith(alice);
			expect(storeGrantGlobalRole).toHaveBeenCalledExactlyOnceWith(
				alice,
				"admin",
			);
		}),
	);

	test(
		"fails with UnknownAuthentication and grants nothing without an account",
		Effect.gen(function* () {
			resolveByAuthentication.mockReturnValueOnce(Effect.succeedNone);
			const error = yield* grantGlobalRole(alice, "admin").pipe(Effect.flip);
			expect(error).toStrictEqual(
				UnknownAuthentication.make({ issuer: "dev", subject: "alice" }),
			);
			expect(storeGrantGlobalRole).not.toHaveBeenCalled();
		}),
	);

	test(
		"reports superadmin for a configured superadmin",
		Effect.gen(function* () {
			expect(yield* grantGlobalRole(root, "admin")).toStrictEqual([
				"admin",
				"superadmin",
			]);
		}),
	);
});

describe("revokeGlobalRole", () => {
	test(
		"refuses to revoke superadmin but revokes admin for a superadmin in config",
		Effect.gen(function* () {
			const error = yield* revokeGlobalRole(root, "superadmin").pipe(
				Effect.flip,
			);
			expect(error).toStrictEqual(
				SuperadminInConfig.make({ issuer: "dev", subject: "root" }),
			);
			expect(yield* revokeGlobalRole(root, "admin")).toStrictEqual([
				"superadmin",
			]);
			expect(storeRevokeGlobalRole).toHaveBeenCalledExactlyOnceWith(
				root,
				"admin",
			);
		}),
	);

	test(
		"revokes superadmin from an authentication not in config",
		Effect.gen(function* () {
			expect(yield* revokeGlobalRole(alice, "superadmin")).toStrictEqual([]);
			expect(storeRevokeGlobalRole).toHaveBeenCalledExactlyOnceWith(
				alice,
				"superadmin",
			);
		}),
	);
});
