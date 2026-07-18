import { HttpApiError } from "@effect/platform";
import { RpcCallError } from "@nodecg/internal";
import { Effect, Match } from "effect";
import type { JsonValue } from "type-fest";

import { FieldRegistryService } from "../../field-registry.ts";

export const getReplicant = (namespace: string, name: string) =>
	Effect.gen(function* () {
		const registry = yield* FieldRegistryService;
		const field = registry.replicant.get(namespace)?.get(name);
		if (typeof field === "undefined") {
			return yield* new HttpApiError.NotFound();
		}
		return yield* field.getEncoded().pipe(
			Effect.catchTags({
				FieldPermissionDenied: () => new HttpApiError.Forbidden(),
				ReplicantNotFound2: () => new HttpApiError.NotFound(),
			}),
		);
	});

export const updateReplicant = (
	namespace: string,
	name: string,
	payload: JsonValue,
) =>
	Effect.gen(function* () {
		const registry = yield* FieldRegistryService;
		const field = registry.replicant.get(namespace)?.get(name);
		if (typeof field === "undefined") {
			return yield* new HttpApiError.NotFound();
		}
		yield* field.setEncoded(payload).pipe(
			Effect.mapError((error) =>
				Match.value(error).pipe(
					Match.tag(
						"FieldPermissionDenied",
						() => new HttpApiError.Forbidden(),
					),
					Match.tag("FieldDecodeError", () => new HttpApiError.BadRequest()),
					Match.tag("ReplicantNotFound", () => new HttpApiError.NotFound()),
					Match.tag("ReplicantNotFound2", () => new HttpApiError.NotFound()),
					Match.exhaustive,
				),
			),
		);
	});

export const getComputed = (namespace: string, name: string) =>
	Effect.gen(function* () {
		const registry = yield* FieldRegistryService;
		const field = registry.computed.get(namespace)?.get(name);
		if (typeof field === "undefined") {
			return yield* new HttpApiError.NotFound();
		}
		return yield* field.getEncoded().pipe(
			Effect.catchTags({
				FieldPermissionDenied: () => new HttpApiError.Forbidden(),
				ComputedNotFound: () => new HttpApiError.NotFound(),
				ReplicantNotFound: () => new HttpApiError.NotFound(),
				ComputedComputeError: () => new HttpApiError.InternalServerError(),
				FieldEncodeError: () => new HttpApiError.InternalServerError(),
			}),
		);
	});

export const publishTopic = (
	namespace: string,
	name: string,
	payload: JsonValue,
) =>
	Effect.gen(function* () {
		const registry = yield* FieldRegistryService;
		const field = registry.topic.get(namespace)?.get(name);
		if (typeof field === "undefined") {
			return yield* new HttpApiError.NotFound();
		}
		yield* field.publishEncoded(payload).pipe(
			Effect.catchTags({
				FieldPermissionDenied: () => new HttpApiError.Forbidden(),
				FieldDecodeError: () => new HttpApiError.BadRequest(),
			}),
		);
	});

export const callRpc = (namespace: string, name: string, payload: JsonValue) =>
	Effect.gen(function* () {
		const registry = yield* FieldRegistryService;
		const field = registry.rpc.get(namespace)?.get(name);
		if (typeof field === "undefined") {
			return yield* new HttpApiError.NotFound();
		}
		return yield* field.callEncoded(payload).pipe(
			Effect.catchTags({
				FieldPermissionDenied: () => new HttpApiError.Forbidden(),
				FieldDecodeError: () => new HttpApiError.BadRequest(),
				RpcCallFailed: (error) => new RpcCallError({ message: error.message }),
				FieldEncodeError: (error) =>
					new RpcCallError({ message: error.message }),
			}),
		);
	});
