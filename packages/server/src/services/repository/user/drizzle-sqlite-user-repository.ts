import { Effect, Layer } from "effect";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { BackendError } from "../repository-errors.ts";
import { UserRepositoryService } from "./user-repository.ts";

export const DrizzleSqliteUserRepository = Layer.effect(
	UserRepositoryService,
	Effect.gen(function* () {
		const db = yield* DrizzleSqliteDatabaseService;

		const listAll = Effect.fn("UserRepository.listAll")(
			function* () {
				const rows = yield* db.query.users.findMany({
					columns: { id: true, accountId: true },
					with: {
						authentications: { columns: { issuer: true, subject: true } },
						account: {
							columns: { displayName: true },
							with: {
								roleGrants: { columns: { namespace: true, roleName: true } },
								globalRoleGrants: { columns: { roleName: true } },
							},
						},
					},
				});
				return rows.map(({ id, accountId, authentications, account }) => ({
					id,
					accountId,
					displayName: account.displayName,
					authentications,
					roles: account.roleGrants.map(({ namespace, roleName }) => ({
						namespace,
						name: roleName,
					})),
					globalRoles: account.globalRoleGrants.map(({ roleName }) => roleName),
				}));
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		return { listAll };
	}),
);
