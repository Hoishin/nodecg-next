import { Effect, type HKT } from "effect";

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
) {
	type Result = {
		[K in keyof T & string]: HKT.Kind<G, never, never, never, T[K]>;
	};

	const result: Partial<Result> = {};

	for (const key of Object.keys(obj) as (keyof T & string)[]) {
		result[key] = transform(obj[key], key);
	}

	return result as Result;
}

export const mapEffectValues =
	<
		F extends HKT.TypeLambda,
		G extends HKT.TypeLambda,
		T extends Record<string, unknown>,
	>() =>
	<E, R>(
		obj: {
			[K in keyof T & string]: HKT.Kind<F, never, never, never, T[K]>;
		},
		transform: <V>(
			value: HKT.Kind<F, never, never, never, V>,
			key: keyof T & string,
		) => Effect.Effect<HKT.Kind<G, never, never, never, V>, E, R>,
	) => {
		type Result = {
			[K in keyof T & string]: HKT.Kind<G, never, never, never, T[K]>;
		};
		return Effect.gen(function* () {
			const result: Partial<Result> = {};
			for (const key of Object.keys(obj) as (keyof T & string)[]) {
				result[key] = yield* transform(obj[key], key);
			}
			return result as Result;
		});
	};
