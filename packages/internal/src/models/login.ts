import { Schema } from "effect";

export const Login = Schema.Struct({
	issuer: Schema.String,
	subject: Schema.String,
});
export type Login = typeof Login.Type;
