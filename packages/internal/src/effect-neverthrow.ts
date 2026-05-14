import { Effect, ManagedRuntime } from "effect";
import { err, ok, type Result } from "neverthrow";

export async function mapEffectToNeverthrow<A, E, R>(
	runtime: ManagedRuntime.ManagedRuntime<R, never>,
	effect: Effect.Effect<A, E, R>,
): Promise<Result<A, E>> {
	return runtime.runPromise(
		Effect.match(effect, {
			onSuccess: (value) => ok(value),
			onFailure: (error) => err(error),
		}),
	);
}

export function mapEffectFnToNeverthrow<A, E, R, Args extends readonly unknown[]>(
	runtime: ManagedRuntime.ManagedRuntime<R, never>,
	fn: (...args: Args) => Effect.Effect<A, E, R>,
) {
	return (...args: Args) => mapEffectToNeverthrow(runtime, fn(...args));
}
