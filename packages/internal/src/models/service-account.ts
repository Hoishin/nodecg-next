import { Schema } from "effect";

import { AccountId } from "./account.ts";

export const ServiceAccountId = Schema.String.pipe(
	Schema.brand("ServiceAccountId"),
);
export type ServiceAccountId = typeof ServiceAccountId.Type;

export const ServiceAccount = Schema.Struct({
	id: ServiceAccountId,
	accountId: AccountId,
	createdBy: Schema.optionalKey(AccountId),
});
export type ServiceAccount = typeof ServiceAccount.Type;
