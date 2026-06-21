import { HttpApiBuilder, HttpApiError } from "@effect/platform";
import { CurrentUser, NodecgApi } from "@nodecg/internal";
import { Effect, Layer, Match } from "effect";

import { buildFieldRegistry } from "../field-registry.ts";
import type { LoadedNamespace } from "../load-namespace.ts";

export const buildNodecgApi = (options: {
	namespaces: ReadonlyArray<LoadedNamespace>;
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
					const field = registry.state.get(namespace)?.get(name);
					if (typeof field === "undefined") {
						return yield* new HttpApiError.NotFound();
					}
					return yield* field.getEncoded().pipe(
						Effect.catchTags({
							StateNotFound: () => new HttpApiError.NotFound(),
						}),
					);
				}),
			)
			.handle("update", ({ path: { namespace, name }, payload }) =>
				Effect.gen(function* () {
					const field = registry.state.get(namespace)?.get(name);
					if (typeof field === "undefined") {
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

	const ComputedGroupLive = HttpApiBuilder.group(
		NodecgApi,
		"Computed",
		(handlers) =>
			handlers.handle("get", ({ path: { namespace, name } }) =>
				Effect.gen(function* () {
					const field = registry.computed.get(namespace)?.get(name);
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
			),
	);

	const AuthGroupLive = HttpApiBuilder.group(NodecgApi, "Auth", (handlers) =>
		handlers.handle("me", () =>
			Effect.gen(function* () {
				const identity = yield* CurrentUser;
				return { identity };
			}),
		),
	);

	return HttpApiBuilder.api(NodecgApi).pipe(
		Layer.provide(HealthGroupLive),
		Layer.provide(StateGroupLive),
		Layer.provide(ComputedGroupLive),
		Layer.provide(AuthGroupLive),
	);
};
