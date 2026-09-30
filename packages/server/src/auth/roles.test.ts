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
	type RoleRepository,
	RoleRepositoryService,
} from "../services/repository/role/role-repository.ts";
import {
	getRoles,
	grantGlobalRole,
	grantRole,
	revokeGlobalRole,
	revokeRole,
	superadminExists,
	SuperadminInConfig,
	UnknownAuthentication,
} from "./roles.ts";

const alice = { issuer: "dev", subject: "alice" };
const root = { issuer: "dev", subject: "root" };
const accountId = AccountId.make("some-account");
const viewer: Role = { namespace: "show", name: RoleName("viewer") };

const resolveByAuthentication = vi.fn<
	AccountRepository["resolveByAuthentication"]
>(() => Effect.succeedSome(accountId));
const read = vi.fn<RoleRepository["read"]>(() =>
	Effect.succeed({ roles: [viewer], globalRoles: ["admin"] }),
);
const globalRoleExists = vi.fn<RoleRepository["globalRoleExists"]>(() =>
	Effect.succeed(false),
);
const insertRole = vi.fn<RoleRepository["grantRole"]>(() => Effect.void);
const deleteRole = vi.fn<RoleRepository["revokeRole"]>(() => Effect.void);
const insertGlobalRole = vi.fn<RoleRepository["grantGlobalRole"]>(
	() => Effect.void,
);
const deleteGlobalRole = vi.fn<RoleRepository["revokeGlobalRole"]>(
	() => Effect.void,
);

afterEach(() => {
	for (const mock of [
		resolveByAuthentication,
		read,
		globalRoleExists,
		insertRole,
		deleteRole,
		insertGlobalRole,
		deleteGlobalRole,
	]) {
		mock.mockReset();
	}
});

const test = testLayer(
	Layer.mergeAll(
		Layer.succeed(AccountRepositoryService, { resolveByAuthentication }),
		Layer.succeed(RoleRepositoryService, {
			read,
			listAll: vi.fn(),
			globalRoleExists,
			grantRole: insertRole,
			revokeRole: deleteRole,
			grantGlobalRole: insertGlobalRole,
			revokeGlobalRole: deleteGlobalRole,
			revokeAllRoles: vi.fn(),
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
			expect(read).toHaveBeenCalledExactlyOnceWith(accountId);
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

	test(
		"reports only the configured superadmin for an authentication without an account",
		Effect.gen(function* () {
			resolveByAuthentication.mockReturnValueOnce(Effect.succeedNone);
			expect(yield* getRoles(root)).toStrictEqual({
				roles: [],
				globalRoles: ["superadmin"],
			});
			expect(read).not.toHaveBeenCalled();
		}),
	);
});

describe("superadminExists", () => {
	test(
		"reports a superadmin in config without reading the repository",
		Effect.gen(function* () {
			expect(yield* superadminExists()).toBe(true);
			expect(globalRoleExists).not.toHaveBeenCalled();
		}),
	);

	test(
		"asks the repository for a superadmin grant when none is in config",
		Effect.gen(function* () {
			globalRoleExists.mockReturnValueOnce(Effect.succeed(true));
			expect(
				yield* superadminExists().pipe(
					Effect.provideService(ConfiguredSuperadmins, []),
				),
			).toBe(true);
			expect(globalRoleExists).toHaveBeenCalledExactlyOnceWith("superadmin");
		}),
	);
});

describe("grantRole", () => {
	test(
		"grants the role to the authentication's account",
		Effect.gen(function* () {
			yield* grantRole(alice, viewer);
			expect(resolveByAuthentication).toHaveBeenCalledExactlyOnceWith(alice);
			expect(insertRole).toHaveBeenCalledExactlyOnceWith(accountId, viewer);
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
			expect(insertRole).not.toHaveBeenCalled();
		}),
	);
});

describe("revokeRole", () => {
	test(
		"revokes the role from the authentication's account",
		Effect.gen(function* () {
			yield* revokeRole(alice, viewer);
			expect(resolveByAuthentication).toHaveBeenCalledExactlyOnceWith(alice);
			expect(deleteRole).toHaveBeenCalledExactlyOnceWith(accountId, viewer);
		}),
	);

	test(
		"fails with UnknownAuthentication and revokes nothing without an account",
		Effect.gen(function* () {
			resolveByAuthentication.mockReturnValueOnce(Effect.succeedNone);
			const error = yield* revokeRole(alice, viewer).pipe(Effect.flip);
			expect(error).toStrictEqual(
				UnknownAuthentication.make({ issuer: "dev", subject: "alice" }),
			);
			expect(deleteRole).not.toHaveBeenCalled();
		}),
	);
});

describe("grantGlobalRole", () => {
	test(
		"grants the global role to the authentication's account",
		Effect.gen(function* () {
			yield* grantGlobalRole(alice, "admin");
			expect(resolveByAuthentication).toHaveBeenCalledExactlyOnceWith(alice);
			expect(insertGlobalRole).toHaveBeenCalledExactlyOnceWith(
				accountId,
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
			expect(insertGlobalRole).not.toHaveBeenCalled();
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
			yield* revokeGlobalRole(root, "admin");
			expect(deleteGlobalRole).toHaveBeenCalledExactlyOnceWith(
				accountId,
				"admin",
			);
		}),
	);

	test(
		"revokes superadmin from an authentication not in config",
		Effect.gen(function* () {
			yield* revokeGlobalRole(alice, "superadmin");
			expect(deleteGlobalRole).toHaveBeenCalledExactlyOnceWith(
				accountId,
				"superadmin",
			);
		}),
	);

	test(
		"fails with UnknownAuthentication and revokes nothing without an account",
		Effect.gen(function* () {
			resolveByAuthentication.mockReturnValueOnce(Effect.succeedNone);
			const error = yield* revokeGlobalRole(alice, "admin").pipe(Effect.flip);
			expect(error).toStrictEqual(
				UnknownAuthentication.make({ issuer: "dev", subject: "alice" }),
			);
			expect(deleteGlobalRole).not.toHaveBeenCalled();
		}),
	);
});
