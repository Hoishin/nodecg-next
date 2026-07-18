import type { RoleName } from "@nodecg/internal";
import { Context, type Effect, type Option, type Redacted } from "effect";

export interface MachineClient {
	readonly id: string;
	readonly displayName: string;
	readonly roles: ReadonlySet<RoleName>;
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

	readonly list: () => Effect.Effect<ReadonlyArray<MachineClient>>;

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
}

export class MachineClientStoreService extends Context.Tag(
	"MachineClientStore",
)<MachineClientStoreService, MachineClientStore>() {}
