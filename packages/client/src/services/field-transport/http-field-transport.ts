import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import { InternalApi } from "@nodecg/internal";
import { toError } from "@nodecg/internal/utils";
import { Effect, Layer, Match } from "effect";
import type { JsonValue } from "type-fest";

import {
	RpcCallFailed,
	FieldGetFailed,
	FieldNotFound,
	FieldPermissionDenied,
	FieldSaveFailed,
	FieldTransportService,
	TopicPublishFailed,
} from "../field-transport/field-transport.ts";

export const HttpFieldTransport = Layer.effect(
	FieldTransportService,
	Effect.gen(function* () {
		const client = yield* HttpApiClient.make(InternalApi);

		const readReplicant = Effect.fn("FieldTransport.readReplicant")(function* (
			namespace: string,
			name: string,
		) {
			return yield* client.Replicant.get({ path: { namespace, name } }).pipe(
				Effect.mapError((error) =>
					Match.value(error).pipe(
						Match.tag("NotFound", () => new FieldNotFound({ namespace, name })),
						Match.tag(
							"Forbidden",
							() => new FieldPermissionDenied({ namespace, name }),
						),
						Match.orElse(
							(e) => new FieldGetFailed({ namespace, name, cause: toError(e) }),
						),
					),
				),
			);
		});

		const readComputed = Effect.fn("FieldTransport.readComputed")(function* (
			namespace: string,
			name: string,
		) {
			return yield* client.Computed.get({ path: { namespace, name } }).pipe(
				Effect.mapError((error) =>
					Match.value(error).pipe(
						Match.tag("NotFound", () => new FieldNotFound({ namespace, name })),
						Match.tag(
							"Forbidden",
							() => new FieldPermissionDenied({ namespace, name }),
						),
						Match.orElse(
							(e) => new FieldGetFailed({ namespace, name, cause: toError(e) }),
						),
					),
				),
			);
		});

		const updateReplicant = Effect.fn("FieldTransport.updateReplicant")(
			function* (namespace: string, name: string, value: JsonValue) {
				yield* client.Replicant.update({
					path: { namespace, name },
					payload: value,
				}).pipe(
					Effect.mapError((error) =>
						Match.value(error).pipe(
							Match.tag(
								"NotFound",
								() => new FieldNotFound({ namespace, name }),
							),
							Match.tag(
								"Forbidden",
								() => new FieldPermissionDenied({ namespace, name }),
							),
							Match.orElse(
								(e) =>
									new FieldSaveFailed({ namespace, name, cause: toError(e) }),
							),
						),
					),
				);
			},
		);

		const publishTopic = Effect.fn("FieldTransport.publishTopic")(function* (
			namespace: string,
			name: string,
			value: JsonValue,
		) {
			yield* client.Topic.publish({
				path: { namespace, name },
				payload: value,
			}).pipe(
				Effect.mapError((error) =>
					Match.value(error).pipe(
						Match.tag("NotFound", () => new FieldNotFound({ namespace, name })),
						Match.tag(
							"Forbidden",
							() => new FieldPermissionDenied({ namespace, name }),
						),
						Match.orElse(
							(e) =>
								new TopicPublishFailed({ namespace, name, cause: toError(e) }),
						),
					),
				),
			);
		});

		const callRpc = Effect.fn("FieldTransport.callRpc")(function* (
			namespace: string,
			name: string,
			request: JsonValue,
		) {
			return yield* client.Rpc.call({
				path: { namespace, name },
				payload: request,
			}).pipe(
				Effect.mapError((error) =>
					Match.value(error).pipe(
						Match.tag("NotFound", () => new FieldNotFound({ namespace, name })),
						Match.tag(
							"Forbidden",
							() => new FieldPermissionDenied({ namespace, name }),
						),
						Match.orElse(
							(e) => new RpcCallFailed({ namespace, name, cause: toError(e) }),
						),
					),
				),
			);
		});

		return {
			readReplicant,
			readComputed,
			updateReplicant,
			publishTopic,
			callRpc,
		};
	}).pipe(Effect.provide(FetchHttpClient.layer)),
);
