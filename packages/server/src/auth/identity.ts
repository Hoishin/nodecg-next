import {
	User,
	AnonymousIdentitySchema,
	ServiceAccount,
} from "@nodecg-next/internal";
import { Clock, Effect, Option } from "effect";

import { RoleRepositoryService } from "../services/repository/role/role-repository.ts";
import { ServiceAccountRepositoryService } from "../services/repository/service-account/service-account-repository.ts";
import { getRoles } from "./roles.ts";
import { hashApiKey } from "./service-accounts.ts";
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

export const resolveServiceAccountIdentity = Effect.fn(
	"resolveServiceAccountIdentity",
)(function* (token: string) {
	const serviceAccounts = yield* ServiceAccountRepositoryService;
	const roleRepository = yield* RoleRepositoryService;
	const now = yield* Clock.currentTimeMillis;
	const hash = yield* hashApiKey(token);
	const resolved = yield* serviceAccounts.resolveByKeyHash(hash, now);
	if (Option.isNone(resolved)) {
		return Option.none();
	}
	const { id, accountId, displayName } = resolved.value;
	const { roles, globalRoles } = yield* roleRepository.read(accountId);
	return Option.some(
		ServiceAccount.make({ id, displayName, roles, globalRoles }),
	);
});
