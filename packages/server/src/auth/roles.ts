import type {
	Authentication,
	GlobalRoleName,
	Role,
} from "@nodecg-next/internal";
import { Effect, Option, Schema } from "effect";

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
	return yield* roleStore.grantGlobalRole(authentication, role);
});
