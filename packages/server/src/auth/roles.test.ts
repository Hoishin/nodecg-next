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
	type AuthenticationRepository,
	AuthenticationRepositoryService,
} from "../services/repository/authentication/authentication-repository.ts";
import {
	type RoleRepository,
	RoleRepositoryService,
} from "../services/repository/role/role-repository.ts";
import {
	getRoles,
	grantGlobalRole,
	revokeGlobalRole,
	superadminExists,
	SuperadminInConfig,
} from "./roles.ts";

const alice = { issuer: "dev", subject: "alice" };
const root = { issuer: "dev", subject: "root" };
const accountId = AccountId.make("some-account");
const viewer: Role = { namespace: "show", name: RoleName("viewer") };

const resolveByAuthentication = vi.fn<
	AccountRepository["resolveByAuthentication"]
>(() => Effect.succeedSome(accountId));
const resolveByAccountId = vi.fn<
	AuthenticationRepository["resolveByAccountId"]
>(() => Effect.succeed([]));
const read = vi.fn<RoleRepository["read"]>(() =>
	Effect.succeed({ roles: [viewer], globalRoles: ["admin"] }),
);
const globalRoleExists = vi.fn<RoleRepository["globalRoleExists"]>(() =>
	Effect.succeed(false),
);
const insertGlobalRole = vi.fn<RoleRepository["grantGlobalRole"]>(
	() => Effect.void,
);
const deleteGlobalRole = vi.fn<RoleRepository["revokeGlobalRole"]>(
	() => Effect.void,
);

afterEach(() => {
	for (const mock of [
		resolveByAuthentication,
		resolveByAccountId,
		read,
		globalRoleExists,
		insertGlobalRole,
		deleteGlobalRole,
	]) {
		mock.mockReset();
	}
});

const test = testLayer(
	Layer.mergeAll(
		Layer.succeed(AccountRepositoryService, { resolveByAuthentication }),
		Layer.succeed(AuthenticationRepositoryService, {
			findOrCreateAuthentication: vi.fn(),
			resolveByAccountId,
			resolveBySession: vi.fn(),
		}),
		Layer.succeed(RoleRepositoryService, {
			read,
			listAll: vi.fn(),
			globalRoleExists,
			grantRoles: vi.fn(),
			grantRole: vi.fn(),
			revokeRole: vi.fn(),
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

describe("grantGlobalRole", () => {
	test(
		"grants the global role to the account",
		Effect.gen(function* () {
			yield* grantGlobalRole(accountId, "admin");
			expect(insertGlobalRole).toHaveBeenCalledExactlyOnceWith(
				accountId,
				"admin",
			);
		}),
	);
});

describe("revokeGlobalRole", () => {
	test(
		"refuses to revoke a superadmin from config",
		Effect.gen(function* () {
			resolveByAccountId.mockReturnValue(Effect.succeed([root]));

			const error = yield* revokeGlobalRole(accountId, "superadmin").pipe(
				Effect.flip,
			);
			expect(error).toStrictEqual(SuperadminInConfig.make({ accountId }));

			yield* revokeGlobalRole(accountId, "admin");
			expect(deleteGlobalRole).toHaveBeenCalledExactlyOnceWith(
				accountId,
				"admin",
			);
		}),
	);

	test(
		"revokes a superadmin not from config",
		Effect.gen(function* () {
			resolveByAccountId.mockReturnValue(Effect.succeed([alice]));

			yield* revokeGlobalRole(accountId, "superadmin");
			expect(resolveByAccountId).toHaveBeenCalledExactlyOnceWith(accountId);
			expect(deleteGlobalRole).toHaveBeenCalledExactlyOnceWith(
				accountId,
				"superadmin",
			);
		}),
	);
});
