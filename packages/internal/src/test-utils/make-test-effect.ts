import { Cause, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";

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
			throw Cause.squash(exit.cause);
		};
}
