import { HttpApiBuilder } from "@effect/platform";

import { RootApi } from "../root-api.ts";
import {
	callRpc,
	getComputed,
	getReplicant,
	publishTopic,
	updateReplicant,
} from "./shared.ts";

export const PublicGroupsLive = HttpApiBuilder.group(
	RootApi,
	"PublicField",
	(handlers) =>
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
);
