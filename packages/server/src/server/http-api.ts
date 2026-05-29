import { HttpApiBuilder, HttpApiError } from "@effect/platform";
import { NodecgApi } from "@nodecg/internal";
import { Effect, Layer, Match } from "effect";

import { stateMetadataKey, type LoadedState } from "../load-state.ts";
import { stateFieldInternal, type StateField } from "../models/state-field.ts";

type LoadedStateFieldInternal = StateField<unknown>[typeof stateFieldInternal];

export const buildNodecgApi = (options: {
	states: ReadonlyArray<LoadedState>;
}) => {
	const registry = new Map<string, Map<string, LoadedStateFieldInternal>>();
	for (const state of options.states) {
		const { namespace } = state[stateMetadataKey];
		const fields =
			registry.get(namespace) ?? new Map<string, LoadedStateFieldInternal>();
		for (const [name, field] of Object.entries(state)) {
			fields.set(name, field[stateFieldInternal]);
		}
		registry.set(namespace, fields);
	}

	const HealthGroupLive = HttpApiBuilder.group(
		NodecgApi,
		"Health",
		(handlers) => handlers.handle("ping", () => Effect.succeed("pong")),
	);

	const StateGroupLive = HttpApiBuilder.group(NodecgApi, "State", (handlers) =>
		handlers
			.handle("get", ({ path: { namespace, name } }) =>
				Effect.gen(function* () {
					const field = registry.get(namespace)?.get(name);
					if (typeof field === "undefined") {
						return yield* new HttpApiError.NotFound();
					}
					return yield* field.getEncoded().pipe(
						Effect.mapError((error) =>
							Match.value(error).pipe(
								Match.tag("StateNotFound", () => new HttpApiError.NotFound()),
								Match.tag(
									"StateGetFailed",
									() => new HttpApiError.InternalServerError(),
								),
								Match.tag(
									"StateValidationError",
									() => new HttpApiError.InternalServerError(),
								),
								Match.exhaustive,
							),
						),
					);
				}),
			)
			.handle("update", ({ path: { namespace, name }, payload }) =>
				Effect.gen(function* () {
					const field = registry.get(namespace)?.get(name);
					if (typeof field === "undefined") {
						return yield* new HttpApiError.NotFound();
					}
					yield* field.setEncoded(payload).pipe(
						Effect.mapError((error) =>
							Match.value(error).pipe(
								Match.tag(
									"StateValidationError",
									() => new HttpApiError.BadRequest(),
								),
								Match.tag("StateNotFound", () => new HttpApiError.NotFound()),
								Match.tag(
									"StateSaveFailed",
									() => new HttpApiError.InternalServerError(),
								),
								Match.exhaustive,
							),
						),
					);
				}),
			),
	);

	return HttpApiBuilder.api(NodecgApi).pipe(
		Layer.provide(HealthGroupLive),
		Layer.provide(StateGroupLive),
	);
};
