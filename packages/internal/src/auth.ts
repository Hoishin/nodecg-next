import { Context, type Option } from "effect";
import {
	HttpApiError,
	HttpApiMiddleware,
	HttpApiSecurity,
} from "effect/unstable/httpapi";

import type { AccountId } from "./models/account.ts";
import type { Identity } from "./models/identity.ts";
import type { User } from "./models/user.ts";

export class CurrentIdentity extends Context.Service<
	CurrentIdentity,
	Identity
>()("CurrentIdentity") {}

export class CurrentUser extends Context.Service<
	CurrentUser,
	{ readonly user: User; readonly accountId: AccountId }
>()("CurrentUser") {}

export class CurrentSessionCaller extends Context.Service<
	CurrentSessionCaller,
	Option.Option<CurrentUser["Service"]>
>()("CurrentSessionCaller") {}

export const sessionCookieName = "nodecg.sid";

export const sessionCookieSecurity = HttpApiSecurity.apiKey({
	key: sessionCookieName,
	in: "cookie",
});

export class UserAuthenticationMiddleware extends HttpApiMiddleware.Service<
	UserAuthenticationMiddleware,
	{ provides: CurrentIdentity | CurrentSessionCaller }
>()("Authentication", {
	error: [HttpApiError.Unauthorized, HttpApiError.InternalServerError],
	security: { cookie: sessionCookieSecurity },
}) {}

export class AdminTierMiddleware extends HttpApiMiddleware.Service<
	AdminTierMiddleware,
	{ requires: CurrentSessionCaller; provides: CurrentUser }
>()("AdminTier", {
	error: [HttpApiError.Unauthorized, HttpApiError.Forbidden],
}) {}

export class SuperadminMiddleware extends HttpApiMiddleware.Service<
	SuperadminMiddleware,
	{ requires: CurrentSessionCaller; provides: CurrentUser }
>()("Superadmin", {
	error: [HttpApiError.Unauthorized, HttpApiError.Forbidden],
}) {}

export class ServiceAccountAuthenticationMiddleware extends HttpApiMiddleware.Service<
	ServiceAccountAuthenticationMiddleware,
	{ provides: CurrentIdentity }
>()("ServiceAccountAuthentication", {
	error: [HttpApiError.Unauthorized, HttpApiError.InternalServerError],
	security: { bearer: HttpApiSecurity.bearer },
}) {}
