import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import { NodecgApi, toError } from "@nodecg/internal";
import { Effect, Layer, Match } from "effect";
import type { JsonValue } from "type-fest";

import {
	StateGetFailed,
	StateNotFound,
	StateSaveFailed,
	StateTransportService,
} from "./state-transport.ts";

export const HttpStateTransport = Layer.effect(
	StateTransportService,
	Effect.gen(function* () {
		const client = yield* HttpApiClient.make(NodecgApi);

		const read = Effect.fn("StateTransport.read")(function* (
			namespace: string,
			name: string,
		) {
			return yield* client.State.get({ path: { namespace, name } }).pipe(
				Effect.mapError((error) =>
					Match.value(error).pipe(
						Match.tag("NotFound", () => new StateNotFound({ namespace, name })),
						Match.orElse(
							(e) => new StateGetFailed({ namespace, name, cause: toError(e) }),
						),
					),
				),
			);
		});

		const update = Effect.fn("StateTransport.update")(function* (
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
						Match.orElse(
							(e) =>
								new StateSaveFailed({ namespace, name, cause: toError(e) }),
						),
					),
				),
			);
		});

		return { read, update };
	}).pipe(Effect.provide(FetchHttpClient.layer)),
);
