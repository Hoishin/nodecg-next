import {
	HumanIdentitySchema,
	type Identity,
	AnonymousIdentitySchema,
} from "@nodecg/internal";
import { Effect, Option } from "effect";

import type { RoleStore } from "../services/role-store/role-store.ts";
import type { SessionStore } from "../services/session-store/session-store.ts";

export const anonymousIdentity = AnonymousIdentitySchema.make();

export const resolveSessionIdentity =
	(deps: { readonly sessions: SessionStore; readonly roleStore: RoleStore }) =>
	(sessionId: string): Effect.Effect<Option.Option<Identity>> =>
		Effect.gen(function* () {
			const resolved = yield* deps.sessions.lookup(sessionId);
			if (Option.isNone(resolved)) {
				return Option.none();
			}
			yield* deps.sessions.refreshTTL(sessionId);
			const account = resolved.value;
			const roles = yield* deps.roleStore.get({
				issuer: account.issuer,
				subject: account.subject,
			});
			return Option.some(HumanIdentitySchema.make({ account, roles }));
		});
