import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import { InternalApi } from "@nodecg/internal";
import { toError } from "@nodecg/internal/utils";
import { Effect, Layer, Match } from "effect";
import type { JsonValue } from "type-fest";

import {
	RpcCallError,
	FieldGetError,
	FieldNotFound,
	FieldPermissionDenied,
	FieldSetError,
	FieldTransportService,
	TopicPublishError,
} from "../field-transport/field-transport.ts";

export const httpFieldTransport = (baseUrl?: string) =>
	Layer.effect(
		FieldTransportService,
		Effect.gen(function* () {
			const client = yield* HttpApiClient.make(InternalApi, { baseUrl });

			const getReplicant = Effect.fn("FieldTransport.getReplicant")(function* (
				namespace: string,
				name: string,
			) {
				return yield* client.Field.replicantGet({
					path: { namespace, fieldName: name },
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
									new FieldGetError({ namespace, name, cause: toError(e) }),
							),
						),
					),
				);
			});

			const getComputed = Effect.fn("FieldTransport.getComputed")(function* (
				namespace: string,
				name: string,
			) {
				return yield* client.Field.computedGet({
					path: { namespace, fieldName: name },
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
									new FieldGetError({ namespace, name, cause: toError(e) }),
							),
						),
					),
				);
			});

			const setReplicant = Effect.fn("FieldTransport.setReplicant")(function* (
				namespace: string,
				name: string,
				value: JsonValue,
			) {
				yield* client.Field.replicantSet({
					path: { namespace, fieldName: name },
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
									new FieldSetError({ namespace, name, cause: toError(e) }),
							),
						),
					),
				);
			});

			const publishTopic = Effect.fn("FieldTransport.publishTopic")(function* (
				namespace: string,
				name: string,
				value: JsonValue,
			) {
				yield* client.Field.topicPublish({
					path: { namespace, fieldName: name },
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
									new TopicPublishError({
										namespace,
										name,
										cause: toError(e),
									}),
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
				return yield* client.Field.rpcCall({
					path: { namespace, fieldName: name },
					payload: request,
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
								(e) => new RpcCallError({ namespace, name, cause: toError(e) }),
							),
						),
					),
				);
			});

			return {
				getReplicant,
				getComputed,
				setReplicant,
				publishTopic,
				callRpc,
			};
		}).pipe(Effect.provide(FetchHttpClient.layer)),
	);
