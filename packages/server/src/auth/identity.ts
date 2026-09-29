import {
	type Identity,
	User,
	AnonymousIdentitySchema,
	ServiceAccount,
} from "@nodecg-next/internal";
import { Effect, Option } from "effect";

import type { ServiceAccountStore } from "../services/service-account-store/service-account-store.ts";
import { getRoles } from "./roles.ts";
import { resolveSession } from "./session.ts";

export const anonymousIdentity = AnonymousIdentitySchema.make({});

export const resolveSessionIdentity = Effect.fn("resolveSessionIdentity")(
	function* (token: string) {
		const resolved = yield* resolveSession(token);
		if (Option.isNone(resolved)) {
			return Option.none();
		}
		const { userId, authentication, displayName } = resolved.value;
		const { roles, globalRoles } = yield* getRoles(authentication);
		return Option.some(
			User.make({
				id: userId,
				authentication,
				displayName,
				roles,
				globalRoles,
			}),
		);
	},
);

export const resolveServiceAccountIdentity =
	(deps: { readonly serviceAccounts: ServiceAccountStore }) =>
	(token: string): Effect.Effect<Option.Option<Identity>> =>
		Effect.gen(function* () {
			const resolved = yield* deps.serviceAccounts.validateApiKey(token);
			return Option.map(resolved, (client) => ServiceAccount.make(client));
		});
