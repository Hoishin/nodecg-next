import { HttpApiBuilder, HttpApiError } from "@effect/platform";
import { NodecgApi } from "@nodecg/internal";
import { Effect, Layer, Match } from "effect";

import {
	buildFieldRegistry,
	type RegistryNamespace,
} from "../load-namespace.ts";

export const buildNodecgApi = (options: {
	namespaces: ReadonlyArray<RegistryNamespace>;
}) => {
	const registry = buildFieldRegistry(options.namespaces);

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
						Effect.catchTags({
							StateNotFound: () => new HttpApiError.NotFound(),
							StateComputeError: () => new HttpApiError.InternalServerError(),
							StateEncodeError: () => new HttpApiError.InternalServerError(),
						}),
					);
				}),
			)
			.handle("update", ({ path: { namespace, name }, payload }) =>
				Effect.gen(function* () {
					const field = registry.get(namespace)?.get(name);
					// Computed fields have no setEncoded — they aren't writable.
					if (typeof field?.setEncoded === "undefined") {
						return yield* new HttpApiError.NotFound();
					}
					yield* field.setEncoded(payload).pipe(
						Effect.mapError((error) =>
							Match.value(error).pipe(
								Match.tag(
									"StateDecodeError",
									() => new HttpApiError.BadRequest(),
								),
								Match.tag("StateNotFound", () => new HttpApiError.NotFound()),
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
