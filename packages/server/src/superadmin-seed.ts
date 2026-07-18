import { ADMIN_ROLE } from "@nodecg/internal";
import { Effect, HashMap, Layer, Option } from "effect";

import { AuthProviderRegistry } from "./auth/auth-provider.ts";
import { config } from "./server-config.ts";
import { InMemoryRoleStore } from "./services/role-store/in-memory-role-store.ts";
import { RoleStoreService } from "./services/role-store/role-store.ts";

export const seedSuperadmins = Layer.effectDiscard(
	Effect.gen(function* () {
		const superadmins = yield* config.superadmins;
		if (Option.isNone(superadmins)) {
			return;
		}
		const roleStore = yield* RoleStoreService;
		const assignments = yield* roleStore.list();
		if (assignments.some(({ roles }) => roles.has(ADMIN_ROLE.superadmin))) {
			yield* Effect.logInfo(
				"Skipping SUPERADMINS seeding: a superadmin already exists",
			);
			return;
		}
		const registry = yield* AuthProviderRegistry;
		yield* Effect.forEach(superadmins.value, ({ provider: name, subject }) =>
			Effect.gen(function* () {
				const provider = HashMap.get(registry, name);
				if (Option.isNone(provider)) {
					return yield* Effect.die(
						new Error(
							`SUPERADMINS entry "${name}:${subject}" names an unknown authentication provider`,
						),
					);
				}
				yield* roleStore.grant(
					{ issuer: provider.value.issuer, subject },
					ADMIN_ROLE.superadmin,
				);
			}),
		);
	}),
);

export const seededRoleStore = seedSuperadmins.pipe(
	Layer.provideMerge(InMemoryRoleStore),
);
