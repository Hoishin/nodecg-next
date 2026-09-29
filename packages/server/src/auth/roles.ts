import type {
	Authentication,
	GlobalRoleName,
	Role,
} from "@nodecg-next/internal";
import { Array, Effect, Match, Option, Schema } from "effect";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { AccountRepositoryService } from "../services/repository/account/account-repository.ts";
import { RoleStoreService } from "../services/role-store/role-store.ts";

export class UnknownAuthentication extends Schema.TaggedError<UnknownAuthentication>()(
	"UnknownAuthentication",
	{ issuer: Schema.String, subject: Schema.String },
) {
	override readonly message = `No account has "${this.subject}" of "${this.issuer}"`;
}

const requireAccount = Effect.fnUntraced(function* (
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

const overlaySuperadmin = Effect.fnUntraced(function* (
	authentication: Authentication,
	globalRoles: ReadonlyArray<GlobalRoleName>,
) {
	return (yield* isConfiguredSuperadmin(authentication))
		? Array.union(globalRoles, ["superadmin"] as const)
		: globalRoles;
});

export const getRoles = Effect.fn("getRoles")(function* (
	authentication: Authentication,
) {
	const roleStore = yield* RoleStoreService;
	const { roles, globalRoles } = yield* roleStore.get(authentication);
	return {
		roles,
		globalRoles: yield* overlaySuperadmin(authentication, globalRoles),
	};
});

export const superadminExists = Effect.fn("superadminExists")(function* () {
	const superadmins = yield* ConfiguredSuperadmins;
	if (superadmins.length > 0) {
		return true;
	}
	const roleStore = yield* RoleStoreService;
	const assignments = yield* roleStore.list;
	return assignments.some(({ globalRoles }) =>
		globalRoles.includes("superadmin"),
	);
});

export const grantRole = Effect.fn("grantRole")(function* (
	authentication: Authentication,
	role: Role,
) {
	const roleStore = yield* RoleStoreService;
	yield* requireAccount(authentication);
	return yield* roleStore.grantRole(authentication, role);
});

export const grantGlobalRole = Effect.fn("grantGlobalRole")(function* (
	authentication: Authentication,
	role: GlobalRoleName,
) {
	const roleStore = yield* RoleStoreService;
	yield* requireAccount(authentication);
	const globalRoles = yield* roleStore.grantGlobalRole(authentication, role);
	return yield* overlaySuperadmin(authentication, globalRoles);
});

export const revokeGlobalRole = Effect.fn("revokeGlobalRole")(function* (
	authentication: Authentication,
	role: GlobalRoleName,
) {
	const roleStore = yield* RoleStoreService;
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
	const globalRoles = yield* roleStore.revokeGlobalRole(authentication, role);
	return yield* overlaySuperadmin(authentication, globalRoles);
});
