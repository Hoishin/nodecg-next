import { Schema } from "effect";

export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
export type AccountId = typeof AccountId.Type;

export const Account = Schema.Struct({
	id: AccountId,
	displayName: Schema.String,
	createdAt: Schema.DateTimeUtcFromString,
});
export type Account = typeof Account.Type;
