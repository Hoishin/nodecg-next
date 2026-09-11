import type { GlobalRoleName, Login, RoleName } from "@nodecg-next/internal";
import { Context, type Effect } from "effect";

export interface RoleGrants {
	readonly roles: ReadonlySet<RoleName>;
	readonly globalRoles: ReadonlySet<GlobalRoleName>;
}

export interface RoleAssignment {
	readonly key: Login;
	readonly roles: ReadonlySet<RoleName>;
	readonly globalRoles: ReadonlySet<GlobalRoleName>;
}

export interface RoleStore {
	readonly get: (key: Login) => Effect.Effect<RoleGrants>;

	readonly list: Effect.Effect<ReadonlyArray<RoleAssignment>>;

	readonly setRoles: (
		key: Login,
		roles: ReadonlySet<RoleName>,
	) => Effect.Effect<void>;

	readonly grantRole: (
		key: Login,
		role: RoleName,
	) => Effect.Effect<ReadonlySet<RoleName>>;

	readonly revokeRole: (
		key: Login,
		role: RoleName,
	) => Effect.Effect<ReadonlySet<RoleName>>;

	readonly setGlobalRoles: (
		key: Login,
		globalRoles: ReadonlySet<GlobalRoleName>,
	) => Effect.Effect<void>;

	readonly grantGlobalRole: (
		key: Login,
		role: GlobalRoleName,
	) => Effect.Effect<ReadonlySet<GlobalRoleName>>;

	readonly revokeGlobalRole: (
		key: Login,
		role: GlobalRoleName,
	) => Effect.Effect<ReadonlySet<GlobalRoleName>>;
}

export class RoleStoreService extends Context.Service<
	RoleStoreService,
	RoleStore
>()("RoleStore") {}
