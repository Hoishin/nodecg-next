import { Context } from "effect";
import {
	HttpApiError,
	HttpApiMiddleware,
	HttpApiSecurity,
} from "effect/unstable/httpapi";

import type { Identity } from "./models/identity.ts";

export class CurrentIdentity extends Context.Service<
	CurrentIdentity,
	Identity
>()("CurrentIdentity") {}

export const sessionCookieName = "nodecg.sid";

export const sessionCookieSecurity = HttpApiSecurity.apiKey({
	key: sessionCookieName,
	in: "cookie",
});

export class UserAuthenticationMiddleware extends HttpApiMiddleware.Service<
	UserAuthenticationMiddleware,
	{ provides: CurrentIdentity }
>()("Authentication", {
	error: HttpApiError.Unauthorized,
	security: { cookie: sessionCookieSecurity },
}) {}

export class AdminTierMiddleware extends HttpApiMiddleware.Service<
	AdminTierMiddleware,
	{ requires: CurrentIdentity }
>()("AdminTier", { error: HttpApiError.Forbidden }) {}

export class SuperadminMiddleware extends HttpApiMiddleware.Service<
	SuperadminMiddleware,
	{ requires: CurrentIdentity }
>()("Superadmin", { error: HttpApiError.Forbidden }) {}

export class ServiceAccountAuthenticationMiddleware extends HttpApiMiddleware.Service<
	ServiceAccountAuthenticationMiddleware,
	{ provides: CurrentIdentity }
>()("ServiceAccountAuthentication", {
	error: HttpApiError.Unauthorized,
	security: { bearer: HttpApiSecurity.bearer },
}) {}
