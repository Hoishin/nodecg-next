import type {
	Authentication,
	GlobalRoleName,
	Role,
} from "@nodecg-next/internal";
import { Array, Effect, Match, Option, Schema } from "effect";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { AccountRepositoryService } from "../services/repository/account/account-repository.ts";
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
	{ issuer: Schema.String, subject: Schema.String },
) {
	override readonly message = `Superadmin "${this.subject}" of "${this.issuer}" comes from NODECG_SUPERADMINS and can only be revoked there`;
}

const isConfiguredSuperadmin = Effect.fnUntraced(function* (
	authentication: Authentication,
) {
	return Array.contains(yield* ConfiguredSuperadmins, authentication);
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
		globalRoles: (yield* isConfiguredSuperadmin(authentication))
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
	yield* roleRepository.grantRole(accountId, role);
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
	authentication: Authentication,
	role: GlobalRoleName,
) {
	const roleRepository = yield* RoleRepositoryService;
	const refused = yield* Match.value(role).pipe(
		Match.when("superadmin", () => isConfiguredSuperadmin(authentication)),
		Match.when("admin", () => Effect.succeed(false)),
		Match.exhaustive,
	);
	if (refused) {
		return yield* SuperadminInConfig.make({
			issuer: authentication.issuer,
			subject: authentication.subject,
		});
	}
	const accountId = yield* resolveAccountId(authentication);
	yield* roleRepository.revokeGlobalRole(accountId, role);
});
