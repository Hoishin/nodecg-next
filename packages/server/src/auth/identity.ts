import {
	User,
	AnonymousIdentitySchema,
	ServiceAccount,
} from "@nodecg-next/internal";
import { Array, DateTime, Effect, Option } from "effect";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { config } from "../server-config.ts";
import { RoleRepositoryService } from "../services/repository/role/role-repository.ts";
import { ServiceAccountRepositoryService } from "../services/repository/service-account/service-account-repository.ts";
import { SessionRepositoryService } from "../services/repository/session/session-repository.ts";
import { hashApiKey } from "./service-accounts.ts";
import { hashSessionToken } from "./session.ts";

export const anonymousIdentity = AnonymousIdentitySchema.make({});

export const resolveSessionIdentity = Effect.fn("resolveSessionIdentity")(
	function* (token: string) {
		const sessions = yield* SessionRepositoryService;
		const superadmins = yield* ConfiguredSuperadmins;
		const ttl = yield* config.sessionTtl;
		const now = yield* DateTime.now;

		const id = yield* hashSessionToken(token);
		const session = yield* sessions.resolve(id);
		if (Option.isNone(session)) {
			return Option.none();
		}
		yield* sessions.refreshTTL(id, DateTime.addDuration(now, ttl));

		const { authentication, user } = session.value;
		return Option.some(
			User.make({
				id: user.id,
				authentication,
				displayName: user.displayName,
				roles: user.roles,
				globalRoles: Array.isArrayNonEmpty(
					Array.intersection(user.authentications, superadmins),
				)
					? Array.union(user.globalRoles, ["superadmin"] as const)
					: user.globalRoles,
			}),
		);
	},
);

export const resolveServiceAccountIdentity = Effect.fn(
	"resolveServiceAccountIdentity",
)(function* (token: string) {
	const serviceAccounts = yield* ServiceAccountRepositoryService;
	const roleRepository = yield* RoleRepositoryService;
	const hash = yield* hashApiKey(token);
	const resolved = yield* serviceAccounts.resolveByKeyHash(hash);
	if (Option.isNone(resolved)) {
		return Option.none();
	}
	const { id, accountId, displayName } = resolved.value;
	const { roles, globalRoles } = yield* roleRepository.read(accountId);
	return Option.some(
		ServiceAccount.make({ id, displayName, roles, globalRoles }),
	);
});
