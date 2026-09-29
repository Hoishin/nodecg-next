import { AccountId, type Role, RoleName } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import {
	type AccountRepository,
	AccountRepositoryService,
} from "../services/repository/account/account-repository.ts";
import {
	type RoleStore,
	RoleStoreService,
} from "../services/role-store/role-store.ts";
import { grantGlobalRole, grantRole, UnknownAuthentication } from "./roles.ts";

const alice = { issuer: "dev", subject: "alice" };
const viewer: Role = { namespace: "show", name: RoleName("viewer") };

const resolveByAuthentication = vi.fn<
	AccountRepository["resolveByAuthentication"]
>(() => Effect.succeedSome(AccountId.make("alice-account")));
const storeGrantRole = vi.fn<RoleStore["grantRole"]>(() =>
	Effect.succeed([viewer]),
);
const storeGrantGlobalRole = vi.fn<RoleStore["grantGlobalRole"]>(() =>
	Effect.succeed(["admin"]),
);

afterEach(() => {
	for (const mock of [
		resolveByAuthentication,
		storeGrantRole,
		storeGrantGlobalRole,
	]) {
		mock.mockReset();
	}
});

const test = testLayer(
	Layer.mergeAll(
		Layer.succeed(AccountRepositoryService, { resolveByAuthentication }),
		Layer.succeed(RoleStoreService, {
			get: vi.fn(),
			list: Effect.die("unused"),
			setRoles: vi.fn(),
			grantRole: storeGrantRole,
			revokeRole: vi.fn(),
			setGlobalRoles: vi.fn(),
			grantGlobalRole: storeGrantGlobalRole,
			revokeGlobalRole: vi.fn(),
		}),
	),
);

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
});
