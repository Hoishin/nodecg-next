import type { AccountId, GlobalRoleName, Role } from "@nodecg-next/internal";
import { and, eq } from "drizzle-orm";
import { Array, Effect, HashMap, type HashSet, Layer, Option } from "effect";

import {
	DrizzleSqliteDatabaseService,
	makeQueryInChunks,
} from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import {
	globalRoleGrants,
	roleGrants,
} from "../../database/drizzle-sqlite/tables.ts";
import { BackendError } from "../repository-errors.ts";
import { RoleRepositoryService, UnknownAccount } from "./role-repository.ts";

export const DrizzleSqliteRoleRepository = Layer.effect(
	RoleRepositoryService,
	Effect.gen(function* () {
		const db = yield* DrizzleSqliteDatabaseService;
		const queryInChunks = yield* makeQueryInChunks;

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
				const rows = yield* db.query.authentications.findMany({
					columns: { issuer: true, subject: true },
					where: {
						user: {
							account: {
								OR: [{ roleGrants: true }, { globalRoleGrants: true }],
							},
						},
					},
					with: {
						user: {
							columns: {},
							with: {
								account: {
									columns: { displayName: true },
									with: {
										roleGrants: {
											columns: { namespace: true, roleName: true },
										},
										globalRoleGrants: { columns: { roleName: true } },
									},
								},
							},
						},
					},
				});
				return rows.map(({ issuer, subject, user: { account } }) => ({
					authentication: { issuer, subject },
					displayName: account.displayName,
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

		const grantRoles = Effect.fn("RoleRepository.grantRoles")(
			function* (grants: HashMap.HashMap<AccountId, HashSet.HashSet<Role>>) {
				const rows = HashMap.toEntries(grants).flatMap(([accountId, roles]) =>
					Array.fromIterable(roles).map(({ namespace, name }) => ({
						accountId,
						namespace,
						roleName: name,
					})),
				);
				yield* queryInChunks(rows, (chunk) =>
					db
						.insert(roleGrants)
						.values(chunk)
						.onConflictDoNothing()
						.pipe(Effect.as([])),
				);
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const requireAccount = Effect.fnUntraced(function* (accountId: AccountId) {
			const account = yield* db.query.accounts
				.findFirst({
					columns: { id: true },
					where: { id: accountId },
				})
				.pipe(Effect.map(Option.fromUndefinedOr));
			if (Option.isNone(account)) {
				return yield* UnknownAccount.make({ accountId });
			}
		});

		const grantRole = Effect.fn("RoleRepository.grantRole")(
			function* (accountId: AccountId, role: Role) {
				yield* db.transaction(() =>
					Effect.gen(function* () {
						yield* requireAccount(accountId);
						yield* db
							.insert(roleGrants)
							.values({
								accountId,
								namespace: role.namespace,
								roleName: role.name,
							})
							.onConflictDoNothing();
					}),
				);
			},
			Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (cause) =>
				BackendError.make({ cause }),
			),
		);

		const revokeRole = Effect.fn("RoleRepository.revokeRole")(
			function* (accountId: AccountId, role: Role) {
				yield* db.transaction(() =>
					Effect.gen(function* () {
						yield* requireAccount(accountId);
						yield* db
							.delete(roleGrants)
							.where(
								and(
									eq(roleGrants.accountId, accountId),
									eq(roleGrants.namespace, role.namespace),
									eq(roleGrants.roleName, role.name),
								),
							);
					}),
				);
			},
			Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (cause) =>
				BackendError.make({ cause }),
			),
		);

		const grantGlobalRole = Effect.fn("RoleRepository.grantGlobalRole")(
			function* (accountId: AccountId, role: GlobalRoleName) {
				yield* db.transaction(() =>
					Effect.gen(function* () {
						yield* requireAccount(accountId);
						yield* db
							.insert(globalRoleGrants)
							.values({ accountId, roleName: role })
							.onConflictDoNothing();
					}),
				);
			},
			Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (cause) =>
				BackendError.make({ cause }),
			),
		);

		const revokeGlobalRole = Effect.fn("RoleRepository.revokeGlobalRole")(
			function* (accountId: AccountId, role: GlobalRoleName) {
				yield* db.transaction(() =>
					Effect.gen(function* () {
						yield* requireAccount(accountId);
						yield* db
							.delete(globalRoleGrants)
							.where(
								and(
									eq(globalRoleGrants.accountId, accountId),
									eq(globalRoleGrants.roleName, role),
								),
							);
					}),
				);
			},
			Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (cause) =>
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
			grantRoles,
			grantRole,
			revokeRole,
			grantGlobalRole,
			revokeGlobalRole,
			revokeAllRoles,
		};
	}),
);
