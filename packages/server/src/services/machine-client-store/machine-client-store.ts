import { Context, type Effect, type Option, type Redacted } from "effect";

export interface MachineClient {
	readonly id: string;
	readonly displayName: string;
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
}

export class MachineClientStoreService extends Context.Tag(
	"MachineClientStore",
)<MachineClientStoreService, MachineClientStore>() {}
