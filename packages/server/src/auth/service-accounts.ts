import type { Identity } from "@nodecg-next/internal";
import {
	Crypto,
	Effect,
	Encoding,
	Match,
	Option,
	Redacted,
	Schema,
} from "effect";

import { AccountRepositoryService } from "../services/repository/account/account-repository.ts";
import { ServiceAccountRepositoryService } from "../services/repository/service-account/service-account-repository.ts";
import { TransactionService } from "../services/transaction/transaction.ts";

export class NotAUser extends Schema.TaggedError<NotAUser>()("NotAUser", {}) {
	override readonly message = "Only a user can create a service account";
}

export class ServerCreatorNotImplemented extends Schema.TaggedError<ServerCreatorNotImplemented>()(
	"ServerCreatorNotImplemented",
	{},
) {
	override readonly message =
		"Creating a service account as the server is not implemented";
}

export const hashApiKey = Effect.fnUntraced(function* (token: string) {
	const crypto = yield* Crypto.Crypto;
	const digest = yield* crypto.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return Encoding.encodeBase64Url(digest);
});

export const newApiKey = Effect.fnUntraced(function* () {
	const crypto = yield* Crypto.Crypto;
	const bytes = yield* crypto.randomBytes(32);
	return Redacted.make(Encoding.encodeBase64Url(bytes));
});

export const createServiceAccount = Effect.fn("createServiceAccount")(
	function* (displayName: string, creator: Identity) {
		const repository = yield* ServiceAccountRepositoryService;
		const accounts = yield* AccountRepositoryService;
		const token = yield* newApiKey();
		const hash = yield* hashApiKey(Redacted.value(token));
		const { serviceAccountId, accountId } = yield* TransactionService.wrap(
			Effect.gen(function* () {
				const createdBy = yield* Match.value(creator).pipe(
					Match.tag("user", ({ authentication }) =>
						accounts.resolveByAuthentication(authentication),
					),
					Match.tag("serviceAccount", "anonymous", () => NotAUser.make()),
					Match.tag("server", () => ServerCreatorNotImplemented.make()),
					Match.exhaustive,
				);
				if (Option.isNone(createdBy)) {
					return yield* NotAUser.make();
				}
				const { serviceAccountId, accountId } = yield* repository.create({
					displayName,
					createdBy: createdBy.value,
				});
				yield* repository.addKey(serviceAccountId, { hash, label: "" });
				return { serviceAccountId, accountId };
			}),
		);
		return { serviceAccountId, accountId, displayName, token };
	},
);
