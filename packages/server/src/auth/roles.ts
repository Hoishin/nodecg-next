import {
	AccountId,
	type Authentication,
	type GlobalRoleName,
} from "@nodecg-next/internal";
import { Array, Effect, Match, Option, Schema } from "effect";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { AccountRepositoryService } from "../services/repository/account/account-repository.ts";
import { AuthenticationRepositoryService } from "../services/repository/authentication/authentication-repository.ts";
import { RoleRepositoryService } from "../services/repository/role/role-repository.ts";
export class SuperadminInConfig extends Schema.TaggedError<SuperadminInConfig>()(
	"SuperadminInConfig",
	{ accountId: AccountId },
) {
	override readonly message = `The superadmin of account "${this.accountId}" comes from NODECG_SUPERADMINS and can only be revoked there`;
}

const isConfiguredSuperadminAuthentication = Effect.fnUntraced(function* (
	authentication: Authentication,
) {
	return Array.contains(yield* ConfiguredSuperadmins, authentication);
});

const isConfiguredSuperadminAccount = Effect.fnUntraced(function* (
	accountId: AccountId,
) {
	const authentications = yield* AuthenticationRepositoryService;
	const superadmins = yield* ConfiguredSuperadmins;
	const held = yield* authentications.resolveByAccountId(accountId);
	return held.some((authentication) =>
		Array.contains(superadmins, authentication),
	);
});

export const getRoles = Effect.fn("getRoles")(function* (
	authentication: Authentication,
) {
	const accounts = yield* AccountRepositoryService;
	const roleRepository = yield* RoleRepositoryService;
	const accountId = yield* accounts.resolveByAuthentication(authentication);
	const { roles, globalRoles } = Option.isNone(accountId)
		? { roles: [], globalRoles: [] }
		: yield* roleRepository.read(accountId.value);
	return {
		roles,
		globalRoles: (yield* isConfiguredSuperadminAuthentication(authentication))
			? Array.union(globalRoles, ["superadmin"] as const)
			: globalRoles,
	};
});

export const superadminExists = Effect.fn("superadminExists")(function* () {
	const superadmins = yield* ConfiguredSuperadmins;
	if (superadmins.length > 0) {
		return true;
	}
	const roleRepository = yield* RoleRepositoryService;
	return yield* roleRepository.globalRoleExists("superadmin");
});

export const grantGlobalRole = Effect.fn("grantGlobalRole")(function* (
	accountId: AccountId,
	role: GlobalRoleName,
) {
	const roleRepository = yield* RoleRepositoryService;
	yield* roleRepository.grantGlobalRole(accountId, role);
});

export const revokeGlobalRole = Effect.fn("revokeGlobalRole")(function* (
	accountId: AccountId,
	role: GlobalRoleName,
) {
	const roleRepository = yield* RoleRepositoryService;
	const refused = yield* Match.value(role).pipe(
		Match.when("superadmin", () => isConfiguredSuperadminAccount(accountId)),
		Match.when("admin", () => Effect.succeed(false)),
		Match.exhaustive,
	);
	if (refused) {
		return yield* SuperadminInConfig.make({ accountId });
	}
	yield* roleRepository.revokeGlobalRole(accountId, role);
});
