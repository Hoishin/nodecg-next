import { AccountId } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import {
	type AuthenticationRepository,
	AuthenticationRepositoryService,
} from "../services/repository/authentication/authentication-repository.ts";
import {
	type RoleRepository,
	RoleRepositoryService,
} from "../services/repository/role/role-repository.ts";
import {
	grantGlobalRole,
	revokeGlobalRole,
	superadminExists,
	SuperadminInConfig,
} from "./roles.ts";

const alice = { issuer: "dev", subject: "alice" };
const root = { issuer: "dev", subject: "root" };
const accountId = AccountId.make("some-account");

const resolveByAccountId = vi.fn<
	AuthenticationRepository["resolveByAccountId"]
>(() => Effect.succeed([]));
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
		resolveByAccountId,
		globalRoleExists,
		insertGlobalRole,
		deleteGlobalRole,
	]) {
		mock.mockReset();
	}
});

const test = testLayer(
	Layer.mergeAll(
		Layer.succeed(AuthenticationRepositoryService, {
			findOrCreateAuthentication: vi.fn(),
			resolveByAccountId,
		}),
		Layer.succeed(RoleRepositoryService, {
			read: vi.fn(),
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
			expect(error).toStrictEqual(
				SuperadminInConfig.make({ accountId, authentication: root }),
			);

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
