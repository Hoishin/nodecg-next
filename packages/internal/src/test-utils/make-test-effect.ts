import { Effect, Exit, Layer, ManagedRuntime, Match, Scope } from "effect";

export function makeTestEffect<ROut>(layer: Layer.Layer<ROut, never, never>) {
	return <A, E>(self: Effect.Effect<A, E, ROut | Scope.Scope>) =>
		async () => {
			const runtime = ManagedRuntime.make(layer);
			const exit = await runtime.runPromise(
				self.pipe(Effect.scoped, Effect.exit),
			);
			if (Exit.isSuccess(exit)) {
				return;
			}
			const error = Match.value(exit.cause).pipe(
				Match.tag("Die", ({ defect }) => defect),
				Match.tag("Fail", ({ error }) => error),
				Match.tag("Interrupt", () => new Error("test interrupted")),
				Match.tag(
					"Parallel",
					() => new Error("test failed with parallel causes", { cause: exit }),
				),
				Match.tag(
					"Sequential",
					() => new Error("test failed with parallel causes", { cause: exit }),
				),
				Match.tag(
					"Empty",
					() => new Error("test failed with empty causes", { cause: exit }),
				),
				Match.exhaustive,
			);
			throw error;
		};
}
