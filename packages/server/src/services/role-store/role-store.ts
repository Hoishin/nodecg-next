import type { GlobalRoleName, RoleName } from "@nodecg-next/internal";
import { Context, type Effect } from "effect";

export interface IdentityKey {
	readonly issuer: string;
	readonly subject: string;
}

export interface RoleGrants {
	readonly roles: ReadonlySet<RoleName>;
	readonly globalRoles: ReadonlySet<GlobalRoleName>;
}

export interface RoleAssignment {
	readonly key: IdentityKey;
	readonly roles: ReadonlySet<RoleName>;
	readonly globalRoles: ReadonlySet<GlobalRoleName>;
}

export interface RoleStore {
	readonly get: (key: IdentityKey) => Effect.Effect<RoleGrants>;

	readonly list: Effect.Effect<ReadonlyArray<RoleAssignment>>;

	readonly set: (
		key: IdentityKey,
		roles: ReadonlySet<RoleName>,
	) => Effect.Effect<void>;

	readonly grant: (
		key: IdentityKey,
		role: RoleName,
	) => Effect.Effect<ReadonlySet<RoleName>>;

	readonly revoke: (
		key: IdentityKey,
		role: RoleName,
	) => Effect.Effect<ReadonlySet<RoleName>>;

	readonly setGlobal: (
		key: IdentityKey,
		globalRoles: ReadonlySet<GlobalRoleName>,
	) => Effect.Effect<void>;

	readonly grantGlobal: (
		key: IdentityKey,
		role: GlobalRoleName,
	) => Effect.Effect<ReadonlySet<GlobalRoleName>>;

	readonly revokeGlobal: (
		key: IdentityKey,
		role: GlobalRoleName,
	) => Effect.Effect<ReadonlySet<GlobalRoleName>>;
}

export class RoleStoreService extends Context.Service<
	RoleStoreService,
	RoleStore
>()("RoleStore") {}
