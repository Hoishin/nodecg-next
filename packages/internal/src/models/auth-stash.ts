import { Schema } from "effect";

export const AuthStash = Schema.Struct({
	provider: Schema.String,
	state: Schema.String,
	codeVerifier: Schema.optionalKey(Schema.String),
	nonce: Schema.optionalKey(Schema.String),
	returnTo: Schema.optionalKey(Schema.String),
});
export type AuthStash = typeof AuthStash.Type;
