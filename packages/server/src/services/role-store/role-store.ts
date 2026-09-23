import type { GlobalRoleName, Login, Role } from "@nodecg-next/internal";
import { Context, type Effect } from "effect";

export interface RoleGrants {
	readonly roles: ReadonlyArray<Role>;
	readonly globalRoles: ReadonlyArray<GlobalRoleName>;
}

export interface RoleAssignment {
	readonly key: Login;
	readonly roles: ReadonlyArray<Role>;
	readonly globalRoles: ReadonlyArray<GlobalRoleName>;
}

export interface RoleStore {
	readonly get: (key: Login) => Effect.Effect<RoleGrants>;

	readonly list: Effect.Effect<ReadonlyArray<RoleAssignment>>;

	readonly setRoles: (
		key: Login,
		roles: ReadonlyArray<Role>,
	) => Effect.Effect<void>;

	readonly grantRole: (
		key: Login,
		role: Role,
	) => Effect.Effect<ReadonlyArray<Role>>;

	readonly revokeRole: (
		key: Login,
		role: Role,
	) => Effect.Effect<ReadonlyArray<Role>>;

	readonly setGlobalRoles: (
		key: Login,
		globalRoles: ReadonlyArray<GlobalRoleName>,
	) => Effect.Effect<void>;

	readonly grantGlobalRole: (
		key: Login,
		role: GlobalRoleName,
	) => Effect.Effect<ReadonlyArray<GlobalRoleName>>;

	readonly revokeGlobalRole: (
		key: Login,
		role: GlobalRoleName,
	) => Effect.Effect<ReadonlyArray<GlobalRoleName>>;
}

export class RoleStoreService extends Context.Service<
	RoleStoreService,
	RoleStore
>()("RoleStore") {}
