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
	(sessionId: Option.Option<string>): Effect.Effect<Option.Option<Identity>> =>
		Effect.gen(function* () {
			if (Option.isNone(sessionId)) {
				return Option.none();
			}
			const resolved = yield* deps.sessions.lookup(sessionId.value);
			if (Option.isNone(resolved)) {
				return Option.none();
			}
			yield* deps.sessions.refreshTTL(sessionId.value);
			const account = resolved.value;
			const roles = yield* deps.roleStore.get({
				issuer: account.issuer,
				subject: account.subject,
			});
			return Option.some(HumanIdentitySchema.make({ account, roles }));
		});
