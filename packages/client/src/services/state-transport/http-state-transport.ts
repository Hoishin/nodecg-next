import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import { NodecgApi } from "@nodecg/internal";
import { toError } from "@nodecg/internal/utils";
import { Effect, Layer, Match } from "effect";
import type { JsonValue } from "type-fest";

import {
	StateGetFailed,
	StateNotFound,
	StatePermissionDenied,
	StateSaveFailed,
	StateTransportService,
} from "./state-transport.ts";

export const HttpStateTransport = Layer.effect(
	StateTransportService,
	Effect.gen(function* () {
		const client = yield* HttpApiClient.make(NodecgApi);

		const readState = Effect.fn("StateTransport.readState")(function* (
			namespace: string,
			name: string,
		) {
			return yield* client.State.get({ path: { namespace, name } }).pipe(
				Effect.mapError((error) =>
					Match.value(error).pipe(
						Match.tag("NotFound", () => new StateNotFound({ namespace, name })),
						Match.tag(
							"Forbidden",
							() => new StatePermissionDenied({ namespace, name }),
						),
						Match.orElse(
							(e) => new StateGetFailed({ namespace, name, cause: toError(e) }),
						),
					),
				),
			);
		});

		const readComputed = Effect.fn("StateTransport.readComputed")(function* (
			namespace: string,
			name: string,
		) {
			return yield* client.Computed.get({ path: { namespace, name } }).pipe(
				Effect.mapError((error) =>
					Match.value(error).pipe(
						Match.tag("NotFound", () => new StateNotFound({ namespace, name })),
						Match.tag(
							"Forbidden",
							() => new StatePermissionDenied({ namespace, name }),
						),
						Match.orElse(
							(e) => new StateGetFailed({ namespace, name, cause: toError(e) }),
						),
					),
				),
			);
		});

		const updateState = Effect.fn("StateTransport.updateState")(function* (
			namespace: string,
			name: string,
			value: JsonValue,
		) {
			yield* client.State.update({
				path: { namespace, name },
				payload: value,
			}).pipe(
				Effect.mapError((error) =>
					Match.value(error).pipe(
						Match.tag("NotFound", () => new StateNotFound({ namespace, name })),
						Match.tag(
							"Forbidden",
							() => new StatePermissionDenied({ namespace, name }),
						),
						Match.orElse(
							(e) =>
								new StateSaveFailed({ namespace, name, cause: toError(e) }),
						),
					),
				),
			);
		});

		return { readState, readComputed, updateState };
	}).pipe(Effect.provide(FetchHttpClient.layer)),
);
