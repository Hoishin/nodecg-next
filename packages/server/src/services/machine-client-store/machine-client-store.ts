import { Context, type Effect, type Redacted } from "effect";

export interface CreatedApiKey {
	readonly id: string;
	readonly displayName: string;
	readonly token: Redacted.Redacted<string>;
}

export class MachineClientStoreService extends Context.Tag(
	"MachineClientStore",
)<
	MachineClientStoreService,
	{
		readonly createApiKey: (input: {
			readonly displayName: string;
		}) => Effect.Effect<CreatedApiKey>;
	}
>() {}
