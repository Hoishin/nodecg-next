import type { RoleName } from "@nodecg/internal";
import { Context, type Effect } from "effect";

export interface IdentityKey {
	readonly issuer: string;
	readonly subject: string;
}

export interface RoleStore {
	readonly get: (key: IdentityKey) => Effect.Effect<ReadonlySet<RoleName>>;

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
