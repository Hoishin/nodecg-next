import { type Identity, ServiceAccountIdentity } from "@nodecg-next/internal";
import { Effect, Option } from "effect";

import type { ServiceAccountStore } from "../services/service-account-store/service-account-store.ts";

export const resolveServiceAccountIdentity =
	(deps: { readonly serviceAccounts: ServiceAccountStore }) =>
	(token: string): Effect.Effect<Option.Option<Identity>> =>
		Effect.gen(function* () {
			const resolved = yield* deps.serviceAccounts.validateApiKey(token);
			return Option.map(resolved, (client) =>
				ServiceAccountIdentity.make(client),
			);
		});
