import {
	AccountId,
	type Authentication,
	type GlobalRoleName,
	type Role,
} from "@nodecg-next/internal";
import { Array, Effect, HashMap, HashSet, Match, Option, Schema } from "effect";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { AccountRepositoryService } from "../services/repository/account/account-repository.ts";
import { AuthenticationRepositoryService } from "../services/repository/authentication/authentication-repository.ts";
import { RoleRepositoryService } from "../services/repository/role/role-repository.ts";
export class UnknownAuthentication extends Schema.TaggedError<UnknownAuthentication>()(
	"UnknownAuthentication",
	{ issuer: Schema.String, subject: Schema.String },
) {
	override readonly message = `No account has "${this.subject}" of "${this.issuer}"`;
}

const resolveAccountId = Effect.fnUntraced(function* (
	authentication: Authentication,
) {
	const accounts = yield* AccountRepositoryService;
	const accountId = yield* accounts.resolveByAuthentication(authentication);
	if (Option.isNone(accountId)) {
		return yield* UnknownAuthentication.make({
			issuer: authentication.issuer,
			subject: authentication.subject,
		});
	}
	return accountId.value;
});

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

export const grantRole = Effect.fn("grantRole")(function* (
	authentication: Authentication,
	role: Role,
) {
	const roleRepository = yield* RoleRepositoryService;
	const accountId = yield* resolveAccountId(authentication);
	yield* roleRepository.grantRoles(
		HashMap.make([accountId, HashSet.make(role)]),
	);
});

export const revokeRole = Effect.fn("revokeRole")(function* (
	authentication: Authentication,
	role: Role,
) {
	const roleRepository = yield* RoleRepositoryService;
	const accountId = yield* resolveAccountId(authentication);
	yield* roleRepository.revokeRole(accountId, role);
});

export const grantGlobalRole = Effect.fn("grantGlobalRole")(function* (
	authentication: Authentication,
	role: GlobalRoleName,
) {
	const roleRepository = yield* RoleRepositoryService;
	const accountId = yield* resolveAccountId(authentication);
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
