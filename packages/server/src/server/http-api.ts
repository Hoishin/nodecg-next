import { HttpApiBuilder, HttpApiError } from "@effect/platform";
import { NodecgApi } from "@nodecg/internal";
import { Effect, Layer, Match } from "effect";
import type { SimplifyDeep } from "type-fest";

import { stateMetadataKey } from "../load-state.ts";
import {
	stateFieldInternal,
	type StateField,
	type StateFieldPromise,
} from "../models/state-field.ts";

type StateFieldCommon = SimplifyDeep<
	Pick<
		StateField<unknown> | StateFieldPromise<unknown>,
		typeof stateFieldInternal
	>
>;
type StateFieldInternal = StateFieldCommon[typeof stateFieldInternal];

export type LoadedState = Record<string, StateFieldCommon> & {
	readonly [stateMetadataKey]: { namespace: string };
};

export const buildNodecgApi = (options: {
	states: ReadonlyArray<LoadedState>;
}) => {
	const registry = new Map<string, Map<string, StateFieldInternal>>();
	for (const state of options.states) {
		const { namespace } = state[stateMetadataKey];
		const fields =
			registry.get(namespace) ?? new Map<string, StateFieldInternal>();
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
					return yield* field.get().pipe(
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
