import type { GlobalRoleName, Role } from "@nodecg-next/internal";
import { Context, type Effect, type Option, type Redacted } from "effect";

export interface MachineClient {
	readonly id: string;
	readonly displayName: string;
	readonly roles: ReadonlyArray<Role>;
	readonly globalRoles: ReadonlyArray<GlobalRoleName>;
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
		roles: ReadonlyArray<Role>,
	) => Effect.Effect<Option.Option<ReadonlyArray<Role>>>;

	readonly grantRole: (
		id: string,
		role: Role,
	) => Effect.Effect<Option.Option<ReadonlyArray<Role>>>;

	readonly revokeRole: (
		id: string,
		role: Role,
	) => Effect.Effect<Option.Option<ReadonlyArray<Role>>>;

	readonly setGlobalRoles: (
		id: string,
		globalRoles: ReadonlyArray<GlobalRoleName>,
	) => Effect.Effect<Option.Option<ReadonlyArray<GlobalRoleName>>>;

	readonly grantGlobalRole: (
		id: string,
		role: GlobalRoleName,
	) => Effect.Effect<Option.Option<ReadonlyArray<GlobalRoleName>>>;

	readonly revokeGlobalRole: (
		id: string,
		role: GlobalRoleName,
	) => Effect.Effect<Option.Option<ReadonlyArray<GlobalRoleName>>>;
}

export class MachineClientStoreService extends Context.Service<
	MachineClientStoreService,
	MachineClientStore
>()("MachineClientStore") {}
