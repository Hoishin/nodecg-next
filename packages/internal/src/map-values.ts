import type { HKT } from "effect";

export function mapValues<
	F extends HKT.TypeLambda,
	G extends HKT.TypeLambda,
	T extends Record<string, unknown>,
>(
	obj: { [K in keyof T & string]: HKT.Kind<F, never, never, never, T[K]> },
	transform: <V>(
		value: HKT.Kind<F, never, never, never, V>,
		key: keyof T & string,
	) => HKT.Kind<G, never, never, never, V>,
): { [K in keyof T & string]: HKT.Kind<G, never, never, never, T[K]> } {
	type Result = { [K in keyof T & string]: HKT.Kind<G, never, never, never, T[K]> };

	const result: Partial<Result> = {};

	for (const key of Object.keys(obj) as (keyof T & string)[]) {
		result[key] = transform(obj[key], key);
	}

	return result as Result;
}
