import {
	AccountId,
	Authentication,
	type GlobalRoleName,
} from "@nodecg-next/internal";
import { Array, Effect, Match, Option, Schema } from "effect";

import { ConfiguredSuperadmins } from "../configured-superadmins.ts";
import { AuthenticationRepositoryService } from "../services/repository/authentication/authentication-repository.ts";
import { RoleRepositoryService } from "../services/repository/role/role-repository.ts";

export class SuperadminInConfig extends Schema.TaggedError<SuperadminInConfig>()(
	"SuperadminInConfig",
	{ accountId: AccountId, authentication: Authentication },
) {
	override readonly message = `Superadmin "${this.authentication.issuer}:${this.authentication.subject}" comes from NODECG_SUPERADMINS and can only be revoked by removing the entry there`;
}

const findConfiguredSuperadmin = Effect.fnUntraced(function* (
	accountId: AccountId,
) {
	const authentications = yield* AuthenticationRepositoryService;
	const superadmins = yield* ConfiguredSuperadmins;
	const held = yield* authentications.resolveByAccountId(accountId);
	return Array.head(Array.intersection(held, superadmins));
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
