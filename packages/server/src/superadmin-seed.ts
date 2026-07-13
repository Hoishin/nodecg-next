import { ADMIN_ROLE } from "@nodecg/internal";
import { Effect, Layer } from "effect";

import { InMemoryRoleStore } from "./services/role-store/in-memory-role-store.ts";
import { RoleStoreService } from "./services/role-store/role-store.ts";

// TODO: remove this once we have superadmin seeding
export const seededRoleStore = (
	superadmins: ReadonlyArray<{
		readonly issuer: string;
		readonly subject: string;
	}>,
) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const roleStore = yield* RoleStoreService;
			yield* Effect.forEach(superadmins, ({ issuer, subject }) =>
				roleStore.grant({ issuer, subject }, ADMIN_ROLE.superadmin),
			);
		}),
	).pipe(Layer.provideMerge(InMemoryRoleStore));
