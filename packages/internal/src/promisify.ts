import type { Effect } from "effect";

export type PromisifyObject<T, KK extends keyof T = keyof T> = {
	readonly [K in keyof T]: K extends KK
		? T[K] extends (...args: infer Args) => Effect.Effect<infer A, any, any>
			? (...args: Args) => Promise<A>
			: T[K] extends Effect.Effect<infer A, any, any>
				? Promise<A>
				: T[K]
		: T[K];
};
