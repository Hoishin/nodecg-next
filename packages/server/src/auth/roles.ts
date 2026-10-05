import {
	AccountId,
	Authentication,
	type GlobalRoleName,
} from "@nodecg-next/internal";
import { Array, Effect, Match, Option, Schema } from "effect";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { AccountRepositoryService } from "../services/repository/account/account-repository.ts";
import { AuthenticationRepositoryService } from "../services/repository/authentication/authentication-repository.ts";
import { RoleRepositoryService } from "../services/repository/role/role-repository.ts";

export class SuperadminInConfig extends Schema.TaggedError<SuperadminInConfig>()(
	"SuperadminInConfig",
	{ accountId: AccountId, authentication: Authentication },
) {
	override readonly message = `Superadmin "${this.authentication.issuer}:${this.authentication.subject}" comes from NODECG_SUPERADMINS and can only be revoked by removing the entry there`;
}

const isConfiguredSuperadminAuthentication = Effect.fnUntraced(function* (
	authentication: Authentication,
) {
	return Array.contains(yield* ConfiguredSuperadmins, authentication);
});

const findConfiguredSuperadmin = Effect.fnUntraced(function* (
	accountId: AccountId,
) {
	const authentications = yield* AuthenticationRepositoryService;
	const superadmins = yield* ConfiguredSuperadmins;
	const held = yield* authentications.resolveByAccountId(accountId);
	return Array.findFirst(held, (authentication) =>
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
	const configured = yield* Match.value(role).pipe(
		Match.when("superadmin", () => findConfiguredSuperadmin(accountId)),
		Match.when("admin", () => Effect.succeedNone),
		Match.exhaustive,
	);
	if (Option.isSome(configured)) {
		return yield* SuperadminInConfig.make({
			accountId,
			authentication: configured.value,
		});
	}
	yield* roleRepository.revokeGlobalRole(accountId, role);
});
