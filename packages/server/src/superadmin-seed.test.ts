import { ADMIN_ROLE } from "@nodecg/internal";
import { testEffect } from "@nodecg/internal/test-utils";
import { Cause, ConfigProvider, Effect, Exit, HashMap, Layer } from "effect";
import { assert, describe, expect, test } from "vitest";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "./auth/auth-provider.ts";
import { InMemoryRoleStore } from "./services/role-store/in-memory-role-store.ts";
import { RoleStoreService } from "./services/role-store/role-store.ts";
import { seededRoleStore, seedSuperadmins } from "./superadmin-seed.ts";

const stubProvider = (name: string, issuer: string): AuthProvider => ({
	name,
	issuer,
	authorize: () => Effect.die("unused"),
	callback: () => Effect.die("unused"),
});

const registry = (providers: ReadonlyArray<AuthProvider>) =>
	Layer.succeed(
		AuthProviderRegistry,
		HashMap.fromIterable(
			providers.map((provider) => [provider.name, provider]),
		),
	);

const env = (vars: Record<string, string>) =>
	Layer.setConfigProvider(
		ConfigProvider.fromMap(new Map(Object.entries(vars))),
	);

const seeded = (
	vars: Record<string, string>,
	providers: ReadonlyArray<AuthProvider>,
) =>
	seededRoleStore.pipe(
		Layer.provide(registry(providers)),
		Layer.provide(env(vars)),
	);

describe("seededRoleStore", () => {
	test(
		"grants superadmin to each SUPERADMINS entry via its provider's issuer",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				expect(
					yield* roles.get({ issuer: "https://idp.test", subject: "root" }),
				).toEqual(new Set([ADMIN_ROLE.superadmin]));
				expect(
					yield* roles.get({ issuer: "https://idp.test", subject: "backup" }),
				).toEqual(new Set([ADMIN_ROLE.superadmin]));
				expect(
					yield* roles.get({ issuer: "https://idp.test", subject: "other" }),
				).toEqual(new Set());
			}).pipe(
				Effect.provide(
					seeded({ SUPERADMINS: "dev:root, dev:backup" }, [
						stubProvider("dev", "https://idp.test"),
					]),
				),
			),
		),
	);

	test(
		"seeds nothing when SUPERADMINS is unset",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				expect(yield* roles.list()).toEqual([]);
			}).pipe(
				Effect.provide(seeded({}, [stubProvider("dev", "https://idp.test")])),
			),
		),
	);

	test(
		"skips seeding when a superadmin already exists",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				expect(
					yield* roles.get({ issuer: "https://idp.test", subject: "root" }),
				).toEqual(new Set());
				expect(
					yield* roles.get({ issuer: "https://idp.test", subject: "existing" }),
				).toEqual(new Set([ADMIN_ROLE.superadmin]));
			}).pipe(
				Effect.provide(
					seedSuperadmins.pipe(
						Layer.provideMerge(
							Layer.effectDiscard(
								Effect.gen(function* () {
									const roles = yield* RoleStoreService;
									yield* roles.grant(
										{ issuer: "https://idp.test", subject: "existing" },
										ADMIN_ROLE.superadmin,
									);
								}),
							).pipe(Layer.provideMerge(InMemoryRoleStore)),
						),
						Layer.provide(registry([stubProvider("dev", "https://idp.test")])),
						Layer.provide(env({ SUPERADMINS: "dev:root" })),
					),
				),
			),
		),
	);

	test(
		"dies when an entry names an unknown provider",
		testEffect(
			Effect.gen(function* () {
				const exit = yield* Layer.build(
					seeded({ SUPERADMINS: "ghost:root" }, [
						stubProvider("dev", "https://idp.test"),
					]),
				).pipe(Effect.exit);
				assert(Exit.isFailure(exit));
				expect(Cause.pretty(exit.cause)).toContain(
					'SUPERADMINS entry "ghost:root" names an unknown authentication provider',
				);
			}),
		),
	);

	test(
		"fails config parsing when an entry is not of the form <provider>:<subject>",
		testEffect(
			Effect.gen(function* () {
				const exit = yield* Layer.build(
					seeded({ SUPERADMINS: "rootonly" }, [
						stubProvider("dev", "https://idp.test"),
					]),
				).pipe(Effect.exit);
				assert(Exit.isFailure(exit));
				expect(Cause.pretty(exit.cause)).toContain(
					'Expected `${string}:${string}`, actual "rootonly"',
				);
			}),
		),
	);
});
