import { Schema } from "effect";

import { AccountId } from "./account.ts";

export const ApiKeyId = Schema.String.pipe(Schema.brand("ApiKeyId"));
export type ApiKeyId = typeof ApiKeyId.Type;

export const ApiKey = Schema.Struct({
	id: ApiKeyId,
	accountId: AccountId,
	label: Schema.String,
	createdAt: Schema.DateTimeUtcFromString,
	expiresAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
});
export type ApiKey = typeof ApiKey.Type;
