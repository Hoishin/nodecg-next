import { User, AnonymousIdentitySchema } from "@nodecg-next/internal";
import { Effect, Option } from "effect";

import type { RoleStore } from "../services/role-store/role-store.ts";
import { resolveSession } from "./session.ts";

export const anonymousIdentity = AnonymousIdentitySchema.make({});

export const resolveSessionIdentity =
	(deps: { readonly roleStore: RoleStore }) => (token: string) =>
		Effect.gen(function* () {
			const resolved = yield* resolveSession(token);
			if (Option.isNone(resolved)) {
				return Option.none();
			}
			const { authentication } = resolved.value;
			const { roles, globalRoles } = yield* deps.roleStore.get({
				issuer: authentication.issuer,
				subject: authentication.subject,
			});
			return Option.some(User.make({ authentication, roles, globalRoles }));
		});
