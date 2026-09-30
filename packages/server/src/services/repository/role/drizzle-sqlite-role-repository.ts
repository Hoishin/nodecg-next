import type { AccountId, GlobalRoleName, Role } from "@nodecg-next/internal";
import { and, eq } from "drizzle-orm";
import { Array, Effect, Layer } from "effect";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import {
	authentications,
	globalRoleGrants,
	roleGrants,
	users,
} from "../../database/drizzle-sqlite/tables.ts";
import { BackendError } from "../repository-errors.ts";
import { RoleRepositoryService } from "./role-repository.ts";

export const DrizzleSqliteRoleRepository = Layer.effect(
	RoleRepositoryService,
	Effect.gen(function* () {
		const db = yield* DrizzleSqliteDatabaseService;

		const read = Effect.fn("RoleRepository.read")(
			function* (accountId: AccountId) {
				const roleRows = yield* db
					.select({
						namespace: roleGrants.namespace,
						name: roleGrants.roleName,
					})
					.from(roleGrants)
					.where(eq(roleGrants.accountId, accountId));
				const globalRoleRows = yield* db
					.select({ name: globalRoleGrants.roleName })
					.from(globalRoleGrants)
					.where(eq(globalRoleGrants.accountId, accountId));
				return {
					roles: roleRows,
					globalRoles: globalRoleRows.map(({ name }) => name),
				};
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const listAll = Effect.fn("RoleRepository.listAll")(
			function* () {
				const roleRows = yield* db
					.select({
						authenticationId: authentications.id,
						issuer: authentications.issuer,
						subject: authentications.subject,
						namespace: roleGrants.namespace,
						name: roleGrants.roleName,
					})
					.from(roleGrants)
					.innerJoin(users, eq(users.accountId, roleGrants.accountId))
					.innerJoin(authentications, eq(authentications.userId, users.id));
				const globalRoleRows = yield* db
					.select({
						authenticationId: authentications.id,
						issuer: authentications.issuer,
						subject: authentications.subject,
						name: globalRoleGrants.roleName,
					})
					.from(globalRoleGrants)
					.innerJoin(users, eq(users.accountId, globalRoleGrants.accountId))
					.innerJoin(authentications, eq(authentications.userId, users.id));
				const rolesByAuthentication = Array.groupBy(
					roleRows,
					({ authenticationId }) => authenticationId,
				);
				const globalRolesByAuthentication = Array.groupBy(
					globalRoleRows,
					({ authenticationId }) => authenticationId,
				);
				const holders = new Map(
					Array.appendAll(roleRows, globalRoleRows).map(
						({ authenticationId, issuer, subject }) => [
							authenticationId,
							{ issuer, subject },
						],
					),
				);
				return Array.fromIterable(holders).map(([id, authentication]) => ({
					authentication,
					roles: (rolesByAuthentication[id] ?? []).map(
						({ namespace, name }) => ({
							namespace,
							name,
						}),
					),
					globalRoles: (globalRolesByAuthentication[id] ?? []).map(
						({ name }) => name,
					),
				}));
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const globalRoleExists = Effect.fn("RoleRepository.globalRoleExists")(
			function* (role: GlobalRoleName) {
				const rows = yield* db
					.select({ accountId: globalRoleGrants.accountId })
					.from(globalRoleGrants)
					.where(eq(globalRoleGrants.roleName, role))
					.limit(1);
				return rows.length > 0;
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const grantRole = Effect.fn("RoleRepository.grantRole")(
			function* (accountId: AccountId, role: Role) {
				yield* db
					.insert(roleGrants)
					.values({ accountId, namespace: role.namespace, roleName: role.name })
					.onConflictDoNothing();
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const revokeRole = Effect.fn("RoleRepository.revokeRole")(
			function* (accountId: AccountId, role: Role) {
				yield* db
					.delete(roleGrants)
					.where(
						and(
							eq(roleGrants.accountId, accountId),
							eq(roleGrants.namespace, role.namespace),
							eq(roleGrants.roleName, role.name),
						),
					);
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const grantGlobalRole = Effect.fn("RoleRepository.grantGlobalRole")(
			function* (accountId: AccountId, role: GlobalRoleName) {
				yield* db
					.insert(globalRoleGrants)
					.values({ accountId, roleName: role })
					.onConflictDoNothing();
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const revokeGlobalRole = Effect.fn("RoleRepository.revokeGlobalRole")(
			function* (accountId: AccountId, role: GlobalRoleName) {
				yield* db
					.delete(globalRoleGrants)
					.where(
						and(
							eq(globalRoleGrants.accountId, accountId),
							eq(globalRoleGrants.roleName, role),
						),
					);
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const revokeAllRoles = Effect.fn("RoleRepository.revokeAllRoles")(
			function* () {
				yield* db.delete(roleGrants);
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		return {
			read,
			listAll,
			globalRoleExists,
			grantRole,
			revokeRole,
			grantGlobalRole,
			revokeGlobalRole,
			revokeAllRoles,
		};
	}),
);
