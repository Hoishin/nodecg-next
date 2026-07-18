import type { RoleName } from "@nodecg/internal";
import { Context, type Effect } from "effect";

export interface IdentityKey {
	readonly issuer: string;
	readonly subject: string;
}

export interface RoleAssignment {
	readonly key: IdentityKey;
	readonly roles: ReadonlySet<RoleName>;
}

export interface RoleStore {
	readonly get: (key: IdentityKey) => Effect.Effect<ReadonlySet<RoleName>>;

	readonly list: () => Effect.Effect<ReadonlyArray<RoleAssignment>>;

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
}

export class RoleStoreService extends Context.Tag("RoleStore")<
	RoleStoreService,
	RoleStore
>() {}
