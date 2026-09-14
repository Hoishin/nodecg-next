import type { GlobalRoleName, Login, RoleName } from "@nodecg-next/internal";
import { Context, type Effect } from "effect";

export interface RoleGrants {
	readonly roles: ReadonlyArray<RoleName>;
	readonly globalRoles: ReadonlyArray<GlobalRoleName>;
}

export interface RoleAssignment {
	readonly key: Login;
	readonly roles: ReadonlyArray<RoleName>;
	readonly globalRoles: ReadonlyArray<GlobalRoleName>;
}

export interface RoleStore {
	readonly get: (key: Login) => Effect.Effect<RoleGrants>;

	readonly list: Effect.Effect<ReadonlyArray<RoleAssignment>>;

	readonly setRoles: (
		key: Login,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<void>;

	readonly grantRole: (
		key: Login,
		role: RoleName,
	) => Effect.Effect<ReadonlyArray<RoleName>>;

	readonly revokeRole: (
		key: Login,
		role: RoleName,
	) => Effect.Effect<ReadonlyArray<RoleName>>;

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
