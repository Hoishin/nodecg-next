import {
	User,
	AnonymousIdentitySchema,
	type CurrentSessionUser,
	ServiceAccount,
} from "@nodecg-next/internal";
import { Array, Effect, Option } from "effect";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { ServiceAccountRepositoryService } from "../services/repository/service-account/service-account-repository.ts";
import { SessionRepositoryService } from "../services/repository/session/session-repository.ts";
import { expandRoleLinks, RoleLinks } from "./role-links.ts";
import { hashApiKey } from "./service-accounts.ts";
import { hashSessionToken } from "./session.ts";

export const anonymousIdentity = AnonymousIdentitySchema.make({});

export const resolveSessionCaller = Effect.fn("resolveSessionCaller")(
	function* (token: string) {
		const sessions = yield* SessionRepositoryService;
		const superadmins = yield* ConfiguredSuperadmins;
		const links = yield* RoleLinks;

		const id = yield* hashSessionToken(token);
		const session = yield* sessions.resolve(id);
		if (Option.isNone(session)) {
			return Option.none();
		}

		const { authentication, user } = session.value;
		return Option.some(
			User.make({
				id: user.id,
				authentication,
				displayName: user.displayName,
				roles: Array.fromIterable(expandRoleLinks(user.roles, links)),
				globalRoles: Array.isArrayNonEmpty(
					Array.intersection(user.authentications, superadmins),
				)
					? Array.union(user.globalRoles, ["superadmin"] as const)
					: user.globalRoles,
			}),
		);
	},
);

export const resolveServiceAccountCaller = Effect.fn(
	"resolveServiceAccountCaller",
)(function* (token: string) {
	const serviceAccounts = yield* ServiceAccountRepositoryService;
	const links = yield* RoleLinks;
	const hash = yield* hashApiKey(token);
	const serviceAccount = yield* serviceAccounts.resolveByKeyHash(hash);
	if (Option.isNone(serviceAccount)) {
		return Option.none();
	}
	const { id, displayName, roles, globalRoles } = serviceAccount.value;
	return Option.some(
		ServiceAccount.make({
			id,
			displayName,
			roles: Array.fromIterable(expandRoleLinks(roles, links)),
			globalRoles,
		}),
	);
});

export const getSessionIdentity = (caller: CurrentSessionUser["Service"]) =>
	caller.pipe(Option.getOrElse(() => anonymousIdentity));
