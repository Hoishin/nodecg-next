import { layer } from "@effect/vitest";
import type { Effect, Layer, Scope } from "effect";

export const testLayer = <R, E>(services: Layer.Layer<R, E>) => {
	const layered = layer(services);
	return (
		name: string,
		effect: Effect.Effect<unknown, unknown, R | Scope.Scope>,
	) => layered((it) => it.effect(name, () => effect));
};
