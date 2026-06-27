import { HttpApiError, HttpApiMiddleware } from "@effect/platform";
import { Context, Schema } from "effect";

export const PublicIdentitySchema = Schema.TaggedStruct("public", {});

export const HumanIdentitySchema = Schema.TaggedStruct("human", {
	issuer: Schema.String,
	subject: Schema.String,
	displayName: Schema.String,
});
export type HumanIdentity = typeof HumanIdentitySchema.Type;

export const MachineIdentitySchema = Schema.TaggedStruct("machine", {
	id: Schema.String,
	displayName: Schema.String,
});
export type MachineIdentity = typeof MachineIdentitySchema.Type;

export const IdentitySchema = Schema.Union(
	PublicIdentitySchema,
	HumanIdentitySchema,
	MachineIdentitySchema,
);
export type Identity = typeof IdentitySchema.Type;

export class CurrentIdentity extends Context.Tag("CurrentIdentity")<
	CurrentIdentity,
	Identity
>() {}

export class AuthenticationMiddleware extends HttpApiMiddleware.Tag<AuthenticationMiddleware>()(
	"Authentication",
	{
		provides: CurrentIdentity,
		failure: HttpApiError.Unauthorized,
	},
) {}
