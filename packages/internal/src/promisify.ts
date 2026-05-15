import type { Effect } from "effect";

export type Promisify<T> = {
	[K in keyof T]: T[K] extends (
		...args: infer Args
	) => Effect.Effect<infer A, any, any>
		? (...args: Args) => Promise<A>
		: T[K];
};
