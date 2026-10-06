import {
	User,
	AnonymousIdentitySchema,
	type CurrentSessionCaller,
	ServiceAccount,
} from "@nodecg-next/internal";
import { Array, Effect, Option } from "effect";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { RoleRepositoryService } from "../services/repository/role/role-repository.ts";
import { ServiceAccountRepositoryService } from "../services/repository/service-account/service-account-repository.ts";
import { SessionRepositoryService } from "../services/repository/session/session-repository.ts";
import { hashApiKey } from "./service-accounts.ts";
import { hashSessionToken } from "./session.ts";

export const anonymousIdentity = AnonymousIdentitySchema.make({});

export const resolveSessionCaller = Effect.fn("resolveSessionCaller")(
	function* (token: string) {
		const sessions = yield* SessionRepositoryService;
		const superadmins = yield* ConfiguredSuperadmins;

		const id = yield* hashSessionToken(token);
		const session = yield* sessions.resolve(id);
		if (Option.isNone(session)) {
			return Option.none();
		}

		const { authentication, user } = session.value;
		return Option.some({
			user: User.make({
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
			accountId: user.accountId,
		});
	},
);

export const resolveServiceAccountCaller = Effect.fn(
	"resolveServiceAccountCaller",
)(function* (token: string) {
	const serviceAccounts = yield* ServiceAccountRepositoryService;
	const roleRepository = yield* RoleRepositoryService;
	const hash = yield* hashApiKey(token);
	const serviceAccount = yield* serviceAccounts.resolveByKeyHash(hash);
	if (Option.isNone(serviceAccount)) {
		return Option.none();
	}
	const { id, accountId, displayName } = serviceAccount.value;
	const { roles, globalRoles } = yield* roleRepository.read(accountId);
	return Option.some({
		serviceAccount: ServiceAccount.make({
			id,
			displayName,
			roles,
			globalRoles,
		}),
		accountId,
	});
});

export const getSessionIdentity = (caller: CurrentSessionCaller["Service"]) =>
	caller.pipe(
		Option.match({
			onNone: () => anonymousIdentity,
			onSome: ({ user }) => user,
		}),
	);
