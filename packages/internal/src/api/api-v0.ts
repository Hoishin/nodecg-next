import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { Schema } from "effect";

import { MachineAuthenticationMiddleware } from "../auth.ts";
import { fieldGroup } from "./shared.ts";

export const MachineTokenRequestSchema = Schema.Struct({
	clientId: Schema.String,
	clientSecret: Schema.String,
});

export const MachineTokenResponseSchema = Schema.Struct({
	accessToken: Schema.String,
	expiresInSeconds: Schema.Number,
});

const OAuthTokenGroup = HttpApiGroup.make("OAuthToken").add(
	HttpApiEndpoint.post("token", "/oauth/token")
		.setPayload(MachineTokenRequestSchema)
		.addSuccess(MachineTokenResponseSchema)
		.addError(HttpApiError.Unauthorized),
);

export const PublicApi = HttpApi.make("PublicApi")
	.add(fieldGroup("PublicField").middleware(MachineAuthenticationMiddleware))
	.add(OAuthTokenGroup)
	.prefix("/api/v0");
