import { it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, HashMap, Layer } from "effect";
import { assert, describe, expect } from "vitest";

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
	ConfigProvider.layer(ConfigProvider.fromEnvRecord(vars));

const seeded = (
	vars: Record<string, string>,
	providers: ReadonlyArray<AuthProvider>,
) =>
	seededRoleStore.pipe(
		Layer.provide(registry(providers)),
		Layer.provide(env(vars)),
	);

describe("seededRoleStore", () => {
	it.effect(
		"grants superadmin to each SUPERADMINS entry via its provider's issuer",
		() =>
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				expect(
					yield* roles.get({ issuer: "https://idp.test", subject: "root" }),
				).toEqual({ roles: new Set(), globalRoles: new Set(["superadmin"]) });
				expect(
					yield* roles.get({ issuer: "https://idp.test", subject: "backup" }),
				).toEqual({ roles: new Set(), globalRoles: new Set(["superadmin"]) });
				expect(
					yield* roles.get({ issuer: "https://idp.test", subject: "other" }),
				).toEqual({ roles: new Set(), globalRoles: new Set() });
			}).pipe(
				Effect.provide(
					seeded({ SUPERADMINS: "dev:root, dev:backup" }, [
						stubProvider("dev", "https://idp.test"),
					]),
				),
			),
	);

	it.effect("seeds nothing when SUPERADMINS is unset", () =>
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.list).toEqual([]);
		}).pipe(
			Effect.provide(seeded({}, [stubProvider("dev", "https://idp.test")])),
		),
	);

	it.effect("seeds nothing when SUPERADMINS is an empty string", () =>
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(yield* roles.list).toEqual([]);
		}).pipe(
			Effect.provide(
				seeded({ SUPERADMINS: "" }, [stubProvider("dev", "https://idp.test")]),
			),
		),
	);

	it.effect("skips seeding when a superadmin already exists", () =>
		Effect.gen(function* () {
			const roles = yield* RoleStoreService;
			expect(
				yield* roles.get({ issuer: "https://idp.test", subject: "root" }),
			).toEqual({ roles: new Set(), globalRoles: new Set() });
			expect(
				yield* roles.get({ issuer: "https://idp.test", subject: "existing" }),
			).toEqual({ roles: new Set(), globalRoles: new Set(["superadmin"]) });
		}).pipe(
			Effect.provide(
				seedSuperadmins.pipe(
					Layer.provideMerge(
						Layer.effectDiscard(
							Effect.gen(function* () {
								const roles = yield* RoleStoreService;
								yield* roles.grantGlobal(
									{ issuer: "https://idp.test", subject: "existing" },
									"superadmin",
								);
							}),
						).pipe(Layer.provideMerge(InMemoryRoleStore)),
					),
					Layer.provide(registry([stubProvider("dev", "https://idp.test")])),
					Layer.provide(env({ SUPERADMINS: "dev:root" })),
				),
			),
		),
	);

	it.effect("dies when an entry names an unknown provider", () =>
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
	);

	it.effect(
		"fails config parsing when an entry is not of the form <provider>:<subject>",
		() =>
			Effect.gen(function* () {
				const exit = yield* Layer.build(
					seeded({ SUPERADMINS: "rootonly" }, [
						stubProvider("dev", "https://idp.test"),
					]),
				).pipe(Effect.exit);
				assert(Exit.isFailure(exit));
				const pretty = Cause.pretty(exit.cause);
				expect(pretty).toContain('["SUPERADMINS"]');
				expect(pretty).toContain(
					"Expected a string matching template literal parts",
				);
			}),
	);
});
