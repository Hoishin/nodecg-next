import {
	AccountId,
	ApiKeyId,
	type GlobalRoleName,
	type Role,
	ServiceAccountId,
} from "@nodecg-next/internal";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { Array, Crypto, DateTime, Effect, Layer, Option } from "effect";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { retryOnIdCollision } from "../../database/drizzle-sqlite/retry-on-id-collision.ts";
import {
	accounts,
	apiKeys,
	globalRoleGrants,
	roleGrants,
	serviceAccounts,
} from "../../database/drizzle-sqlite/tables.ts";
import { BackendError } from "../repository-errors.ts";
import {
	type NewApiKey,
	ServiceAccountRepositoryService,
} from "./service-account-repository.ts";

export const DrizzleSqliteServiceAccountRepository = Layer.effect(
	ServiceAccountRepositoryService,
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const db = yield* DrizzleSqliteDatabaseService;

		const selectAccount = Effect.fnUntraced(function* (id: ServiceAccountId) {
			const rows = yield* db
				.select({ accountId: serviceAccounts.accountId })
				.from(serviceAccounts)
				.where(eq(serviceAccounts.id, id));
			return Array.head(rows);
		});

		const insertKey = Effect.fn(function* (
			serviceAccountId: ServiceAccountId,
			key: NewApiKey,
		) {
			const now = yield* DateTime.now;
			yield* db.insert(apiKeys).values({
				id: ApiKeyId.make(yield* crypto.randomUUIDv4),
				serviceAccountId,
				keyHash: key.hash,
				label: key.label,
				createdAt: DateTime.toEpochMillis(now),
			});
		}, retryOnIdCollision);

		const insertAccount = Effect.fn(function* (displayName: string) {
			const now = yield* DateTime.now;
			const uuid = yield* crypto.randomUUIDv4;
			const id = AccountId.make(uuid);
			yield* db.insert(accounts).values({
				id,
				displayName,
				createdAt: DateTime.toEpochMillis(now),
			});
			return id;
		}, retryOnIdCollision);

		const insertServiceAccount = Effect.fn(function* (
			accountId: AccountId,
			createdBy: AccountId,
		) {
			const uuid = yield* crypto.randomUUIDv4;
			const id = ServiceAccountId.make(uuid);
			yield* db.insert(serviceAccounts).values({ id, accountId, createdBy });
			return id;
		}, retryOnIdCollision);

		const create = Effect.fn("ServiceAccountRepository.create")(
			function* (input: {
				readonly displayName: string;
				readonly createdBy: AccountId;
			}) {
				return yield* db.transaction(() =>
					Effect.gen(function* () {
						const accountId = yield* insertAccount(input.displayName);
						const serviceAccountId = yield* insertServiceAccount(
							accountId,
							input.createdBy,
						);
						return { serviceAccountId, accountId };
					}),
				);
			},
			Effect.catchTag(
				["EffectDrizzleQueryError", "SqlError", "PlatformError"],
				(cause) => BackendError.make({ cause }),
			),
		);

		const createWithId = Effect.fn("ServiceAccountRepository.createWithId")(
			function* (input: {
				readonly id: ServiceAccountId;
				readonly displayName: string;
				readonly createdBy: AccountId;
			}) {
				return yield* db.transaction(() =>
					Effect.gen(function* () {
						const accountId = yield* insertAccount(input.displayName);
						yield* db.insert(serviceAccounts).values({
							id: input.id,
							accountId,
							createdBy: input.createdBy,
						});
						return { serviceAccountId: input.id, accountId };
					}),
				);
			},
			Effect.catchTag(
				["EffectDrizzleQueryError", "SqlError", "PlatformError"],
				(cause) => BackendError.make({ cause }),
			),
		);

		const resolveById = Effect.fn("ServiceAccountRepository.resolveById")(
			function* (id: ServiceAccountId) {
				const rows = yield* db
					.select({
						id: serviceAccounts.id,
						accountId: serviceAccounts.accountId,
						displayName: accounts.displayName,
					})
					.from(serviceAccounts)
					.innerJoin(accounts, eq(accounts.id, serviceAccounts.accountId))
					.where(eq(serviceAccounts.id, id));
				return Array.head(rows);
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const resolveByKeyHash = Effect.fn(
			"ServiceAccountRepository.resolveByKeyHash",
		)(
			function* (hash: string) {
				const now = yield* DateTime.now;
				const rows = yield* db
					.select({
						id: serviceAccounts.id,
						accountId: serviceAccounts.accountId,
						displayName: accounts.displayName,
					})
					.from(apiKeys)
					.innerJoin(
						serviceAccounts,
						eq(serviceAccounts.id, apiKeys.serviceAccountId),
					)
					.innerJoin(accounts, eq(accounts.id, serviceAccounts.accountId))
					.where(
						and(
							eq(apiKeys.keyHash, hash),
							or(
								isNull(apiKeys.expiresAt),
								gt(apiKeys.expiresAt, DateTime.toEpochMillis(now)),
							),
						),
					);
				return Array.head(rows);
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const listAll = Effect.fn("ServiceAccountRepository.listAll")(
			function* () {
				const rows = yield* db
					.select({
						id: serviceAccounts.id,
						accountId: serviceAccounts.accountId,
						displayName: accounts.displayName,
					})
					.from(serviceAccounts)
					.innerJoin(accounts, eq(accounts.id, serviceAccounts.accountId));
				const roleRows = yield* db
					.select({
						accountId: roleGrants.accountId,
						namespace: roleGrants.namespace,
						name: roleGrants.roleName,
					})
					.from(roleGrants)
					.innerJoin(
						serviceAccounts,
						eq(serviceAccounts.accountId, roleGrants.accountId),
					);
				const globalRoleRows = yield* db
					.select({
						accountId: globalRoleGrants.accountId,
						name: globalRoleGrants.roleName,
					})
					.from(globalRoleGrants)
					.innerJoin(
						serviceAccounts,
						eq(serviceAccounts.accountId, globalRoleGrants.accountId),
					);
				const rolesByAccount = Array.groupBy(
					roleRows,
					({ accountId }) => accountId,
				);
				const globalRolesByAccount = Array.groupBy(
					globalRoleRows,
					({ accountId }) => accountId,
				);
				return rows.map(({ id, accountId, displayName }) => ({
					id,
					displayName,
					roles: (rolesByAccount[accountId] ?? []).map(
						({ namespace, name }) => ({ namespace, name }),
					),
					globalRoles: (globalRolesByAccount[accountId] ?? []).map(
						({ name }) => name,
					),
				}));
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const addKey = Effect.fn("ServiceAccountRepository.addKey")(
			function* (id: ServiceAccountId, key: NewApiKey) {
				yield* insertKey(id, key);
			},
			Effect.catchTag(["EffectDrizzleQueryError", "PlatformError"], (cause) =>
				BackendError.make({ cause }),
			),
		);

		const replaceKey = Effect.fn("ServiceAccountRepository.replaceKey")(
			function* (id: ServiceAccountId, key: NewApiKey) {
				return yield* db.transaction(() =>
					Effect.gen(function* () {
						const found = Array.head(
							yield* db
								.select({ displayName: accounts.displayName })
								.from(serviceAccounts)
								.innerJoin(accounts, eq(accounts.id, serviceAccounts.accountId))
								.where(eq(serviceAccounts.id, id)),
						);
						if (Option.isNone(found)) {
							return found;
						}
						yield* db.delete(apiKeys).where(eq(apiKeys.serviceAccountId, id));
						yield* insertKey(id, key);
						return found;
					}),
				);
			},
			Effect.catchTag(
				["EffectDrizzleQueryError", "SqlError", "PlatformError"],
				(cause) => BackendError.make({ cause }),
			),
		);

		const deleteOne = Effect.fn("ServiceAccountRepository.delete")(
			function* (id: ServiceAccountId) {
				const deleted = yield* db
					.delete(accounts)
					.where(
						inArray(
							accounts.id,
							db
								.select({ accountId: serviceAccounts.accountId })
								.from(serviceAccounts)
								.where(eq(serviceAccounts.id, id)),
						),
					)
					.returning({ id: accounts.id });
				return deleted.length > 0;
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		const grantRole = Effect.fn("ServiceAccountRepository.grantRole")(
			function* (id: ServiceAccountId, role: Role) {
				return yield* db.transaction(() =>
					Effect.gen(function* () {
						const account = yield* selectAccount(id);
						if (Option.isNone(account)) {
							return false;
						}
						yield* db
							.insert(roleGrants)
							.values({
								accountId: account.value.accountId,
								namespace: role.namespace,
								roleName: role.name,
							})
							.onConflictDoNothing();
						return true;
					}),
				);
			},
			Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (cause) =>
				BackendError.make({ cause }),
			),
		);

		const grantGlobalRole = Effect.fn(
			"ServiceAccountRepository.grantGlobalRole",
		)(
			function* (id: ServiceAccountId, role: GlobalRoleName) {
				return yield* db.transaction(() =>
					Effect.gen(function* () {
						const account = yield* selectAccount(id);
						if (Option.isNone(account)) {
							return false;
						}
						yield* db
							.insert(globalRoleGrants)
							.values({ accountId: account.value.accountId, roleName: role })
							.onConflictDoNothing();
						return true;
					}),
				);
			},
			Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (cause) =>
				BackendError.make({ cause }),
			),
		);

		const revokeRole = Effect.fn("ServiceAccountRepository.revokeRole")(
			function* (id: ServiceAccountId, role: Role) {
				return yield* db.transaction(() =>
					Effect.gen(function* () {
						const account = yield* selectAccount(id);
						if (Option.isNone(account)) {
							return false;
						}
						yield* db
							.delete(roleGrants)
							.where(
								and(
									eq(roleGrants.accountId, account.value.accountId),
									eq(roleGrants.namespace, role.namespace),
									eq(roleGrants.roleName, role.name),
								),
							);
						return true;
					}),
				);
			},
			Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (cause) =>
				BackendError.make({ cause }),
			),
		);

		const revokeGlobalRole = Effect.fn(
			"ServiceAccountRepository.revokeGlobalRole",
		)(
			function* (id: ServiceAccountId, role: GlobalRoleName) {
				return yield* db.transaction(() =>
					Effect.gen(function* () {
						const account = yield* selectAccount(id);
						if (Option.isNone(account)) {
							return false;
						}
						yield* db
							.delete(globalRoleGrants)
							.where(
								and(
									eq(globalRoleGrants.accountId, account.value.accountId),
									eq(globalRoleGrants.roleName, role),
								),
							);
						return true;
					}),
				);
			},
			Effect.catchTag(["EffectDrizzleQueryError", "SqlError"], (cause) =>
				BackendError.make({ cause }),
			),
		);

		return {
			create,
			createWithId,
			resolveById,
			resolveByKeyHash,
			listAll,
			addKey,
			replaceKey,
			delete: deleteOne,
			grantRole,
			revokeRole,
			grantGlobalRole,
			revokeGlobalRole,
		};
	}),
);
