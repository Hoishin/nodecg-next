import { HttpApiError, HttpApiMiddleware } from "@effect/platform";
import { Context, Schema } from "effect";

export const IdentitySchema = Schema.TaggedStruct("public", {});
export type Identity = typeof IdentitySchema.Type;

export class CurrentUser extends Context.Tag("CurrentUser")<
	CurrentUser,
	Identity
>() {}

export class AuthenticationMiddleware extends HttpApiMiddleware.Tag<AuthenticationMiddleware>()(
	"Authentication",
	{
		provides: CurrentUser,
		failure: HttpApiError.Unauthorized,
	},
) {}
