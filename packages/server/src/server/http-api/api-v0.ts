import { HttpApiBuilder, HttpApiError } from "@effect/platform";
import { Layer } from "effect";

import type { FieldRegistry } from "../../field-registry.ts";
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

export const buildPublicGroups = (registry: FieldRegistry) =>
	Layer.mergeAll(
		HttpApiBuilder.group(RootApi, "PublicField", (handlers) =>
			handlers
				.handle("replicantGet", ({ path: { namespace, fieldName } }) =>
					getReplicant(registry, namespace, fieldName),
				)
				.handle(
					"replicantUpdate",
					({ path: { namespace, fieldName }, payload }) =>
						updateReplicant(registry, namespace, fieldName, payload),
				)
				.handle("computedGet", ({ path: { namespace, fieldName } }) =>
					getComputed(registry, namespace, fieldName),
				)
				.handle("topicPublish", ({ path: { namespace, fieldName }, payload }) =>
					publishTopic(registry, namespace, fieldName, payload),
				)
				.handle("rpcCall", ({ path: { namespace, fieldName }, payload }) =>
					callRpc(registry, namespace, fieldName, payload),
				),
		),
		OAuthTokenGroupLive,
	);
