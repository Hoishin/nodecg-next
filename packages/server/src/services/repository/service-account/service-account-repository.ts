import type {
	AccountId,
	GlobalRoleName,
	Role,
	ServiceAccountId,
} from "@nodecg-next/internal";
import { Context, type Effect, type Option } from "effect";

import type { BackendError } from "../repository-errors.ts";

export interface NewApiKey {
	readonly hash: string;
	readonly label: string;
}

export interface ServiceAccountRepository {
	readonly create: (input: {
		readonly displayName: string;
		readonly createdBy: AccountId;
	}) => Effect.Effect<
		{
			serviceAccountId: ServiceAccountId;
			accountId: AccountId;
		},
		BackendError
	>;

	readonly createWithId: (input: {
		readonly id: ServiceAccountId;
		readonly displayName: string;
		readonly createdBy: AccountId;
	}) => Effect.Effect<
		{
			serviceAccountId: ServiceAccountId;
			accountId: AccountId;
		},
		BackendError
	>;

	readonly resolveById: (id: ServiceAccountId) => Effect.Effect<
		Option.Option<{
			readonly id: ServiceAccountId;
			readonly accountId: AccountId;
			readonly displayName: string;
		}>,
		BackendError
	>;

	readonly resolveByKeyHash: (hash: string) => Effect.Effect<
		Option.Option<{
			readonly id: ServiceAccountId;
			readonly accountId: AccountId;
			readonly displayName: string;
		}>,
		BackendError
	>;

	readonly listAll: () => Effect.Effect<
		ReadonlyArray<{
			readonly id: ServiceAccountId;
			readonly displayName: string;
			readonly roles: ReadonlyArray<Role>;
			readonly globalRoles: ReadonlyArray<GlobalRoleName>;
		}>,
		BackendError
	>;

	readonly addKey: (
		id: ServiceAccountId,
		key: NewApiKey,
	) => Effect.Effect<void, BackendError>;

	readonly replaceKey: (
		id: ServiceAccountId,
		key: NewApiKey,
	) => Effect.Effect<
		Option.Option<{ readonly displayName: string }>,
		BackendError
	>;

	readonly delete: (
		id: ServiceAccountId,
	) => Effect.Effect<boolean, BackendError>;

	readonly grantRole: (
		id: ServiceAccountId,
		role: Role,
	) => Effect.Effect<boolean, BackendError>;

	readonly revokeRole: (
		id: ServiceAccountId,
		role: Role,
	) => Effect.Effect<boolean, BackendError>;

	readonly grantGlobalRole: (
		id: ServiceAccountId,
		role: GlobalRoleName,
	) => Effect.Effect<boolean, BackendError>;

	readonly revokeGlobalRole: (
		id: ServiceAccountId,
		role: GlobalRoleName,
	) => Effect.Effect<boolean, BackendError>;
}

export class ServiceAccountRepositoryService extends Context.Service<
	ServiceAccountRepositoryService,
	ServiceAccountRepository
>()("ServiceAccountRepository") {}
