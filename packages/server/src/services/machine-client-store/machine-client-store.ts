import type { GlobalRoleName, RoleName } from "@nodecg-next/internal";
import { Context, type Effect, type Option, type Redacted } from "effect";

export interface MachineClient {
	readonly id: string;
	readonly displayName: string;
	readonly roles: ReadonlySet<RoleName>;
	readonly globalRoles: ReadonlySet<GlobalRoleName>;
}

export interface CreatedApiKey {
	readonly id: string;
	readonly displayName: string;
	readonly token: Redacted.Redacted<string>;
}

export interface MachineClientStore {
	readonly createApiKey: (input: {
		readonly displayName: string;
	}) => Effect.Effect<CreatedApiKey>;

	readonly validateApiKey: (
		token: string,
	) => Effect.Effect<Option.Option<MachineClient>>;

	readonly list: Effect.Effect<ReadonlyArray<MachineClient>>;

	readonly revoke: (id: string) => Effect.Effect<Option.Option<MachineClient>>;

	readonly refreshApiKey: (
		id: string,
	) => Effect.Effect<Option.Option<CreatedApiKey>>;

	readonly setRoles: (
		id: string,
		roles: ReadonlySet<RoleName>,
	) => Effect.Effect<Option.Option<ReadonlySet<RoleName>>>;

	readonly grantRole: (
		id: string,
		role: RoleName,
	) => Effect.Effect<Option.Option<ReadonlySet<RoleName>>>;

	readonly revokeRole: (
		id: string,
		role: RoleName,
	) => Effect.Effect<Option.Option<ReadonlySet<RoleName>>>;

	readonly setGlobalRoles: (
		id: string,
		globalRoles: ReadonlySet<GlobalRoleName>,
	) => Effect.Effect<Option.Option<ReadonlySet<GlobalRoleName>>>;

	readonly grantGlobal: (
		id: string,
		role: GlobalRoleName,
	) => Effect.Effect<Option.Option<ReadonlySet<GlobalRoleName>>>;

	readonly revokeGlobal: (
		id: string,
		role: GlobalRoleName,
	) => Effect.Effect<Option.Option<ReadonlySet<GlobalRoleName>>>;
}

export class MachineClientStoreService extends Context.Service<
	MachineClientStoreService,
	MachineClientStore
>()("MachineClientStore") {}
