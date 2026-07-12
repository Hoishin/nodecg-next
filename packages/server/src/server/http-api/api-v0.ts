import { HttpApiBuilder, HttpApiError } from "@effect/platform";
import { Layer } from "effect";

import { RootApi } from "../root-api.ts";
import {
	callRpc,
	getComputed,
	getReplicant,
	publishTopic,
	updateReplicant,
} from "./shared.ts";

const OAuthTokenGroupLive = HttpApiBuilder.group(
	RootApi,
	"OAuthToken",
	(handlers) => handlers.handle("token", () => new HttpApiError.Unauthorized()),
);

export const PublicGroupsLive = Layer.mergeAll(
	HttpApiBuilder.group(RootApi, "PublicField", (handlers) =>
		handlers
			.handle("replicantGet", ({ path: { namespace, fieldName } }) =>
				getReplicant(namespace, fieldName),
			)
			.handle(
				"replicantUpdate",
				({ path: { namespace, fieldName }, payload }) =>
					updateReplicant(namespace, fieldName, payload),
			)
			.handle("computedGet", ({ path: { namespace, fieldName } }) =>
				getComputed(namespace, fieldName),
			)
			.handle("topicPublish", ({ path: { namespace, fieldName }, payload }) =>
				publishTopic(namespace, fieldName, payload),
			)
			.handle("rpcCall", ({ path: { namespace, fieldName }, payload }) =>
				callRpc(namespace, fieldName, payload),
			),
	),
	OAuthTokenGroupLive,
);
