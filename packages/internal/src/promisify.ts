import { Effect, type ManagedRuntime } from "effect";

export type PromisifyObject<T> = {
	readonly [K in keyof T]: T[K] extends (
		...args: infer Args
	) => Effect.Effect<infer A, any, any>
		? (...args: Args) => Promise<A>
		: T[K] extends Effect.Effect<infer A, any, any>
			? Promise<A>
			: T[K];
};

export const promisifyEffectFn = <Args extends unknown[], A, E, MRR, MRE>(
	effectFn: (...args: Args) => Effect.Effect<A, E, never>,
	runtime?: ManagedRuntime.ManagedRuntime<MRR, MRE>,
) => {
	return (...args: Args) => (runtime ?? Effect).runPromise(effectFn(...args));
};
