import { type Identity, MachineIdentitySchema } from "@nodecg/internal";
import { Effect, Option } from "effect";

import type { MachineClientStore } from "../services/machine-client-store/machine-client-store.ts";

export const resolveMachineIdentity =
	(deps: { readonly machines: MachineClientStore }) =>
	(token: string): Effect.Effect<Option.Option<Identity>> =>
		Effect.gen(function* () {
			const resolved = yield* deps.machines.validateApiKey(token);
			return Option.map(resolved, (client) =>
				MachineIdentitySchema.make(client),
			);
		});
