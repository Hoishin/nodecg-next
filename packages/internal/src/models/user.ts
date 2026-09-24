import { Schema } from "effect";

import { AccountId } from "./account.ts";

export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

export const User = Schema.Struct({
	id: UserId,
	accountId: AccountId,
	email: Schema.optionalKey(Schema.String),
});
export type User = typeof User.Type;
