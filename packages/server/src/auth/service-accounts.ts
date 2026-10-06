import type { UserId } from "@nodecg-next/internal";
import { Crypto, Effect, Encoding, Redacted } from "effect";

import { ServiceAccountRepositoryService } from "../services/repository/service-account/service-account-repository.ts";
import { TransactionService } from "../services/transaction/transaction.ts";

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
	function* (displayName: string, createdBy: UserId) {
		const repository = yield* ServiceAccountRepositoryService;
		const token = yield* newApiKey();
		const hash = yield* hashApiKey(Redacted.value(token));
		const serviceAccountId = yield* TransactionService.wrap(
			Effect.gen(function* () {
				const serviceAccountId = yield* repository.create({
					displayName,
					createdBy,
				});
				yield* repository.addKey(serviceAccountId, { hash, label: "" });
				return serviceAccountId;
			}),
		);
		return { serviceAccountId, displayName, token };
	},
);
