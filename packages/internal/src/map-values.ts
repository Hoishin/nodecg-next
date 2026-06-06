import { Effect, type HKT } from "effect";

export function mapValues<
	F extends HKT.TypeLambda,
	G extends HKT.TypeLambda,
	T extends Record<string, unknown>,
>(
	obj: {
		readonly [K in keyof T & string]: HKT.Kind<F, never, never, never, T[K]>;
	},
	transform: <V>(
		value: HKT.Kind<F, never, never, never, V>,
		key: keyof T & string,
	) => HKT.Kind<G, never, never, never, V>,
): {
	readonly [K in keyof T & string]: HKT.Kind<G, never, never, never, T[K]>;
} {
	const result: Partial<{
		readonly [K in keyof T & string]: HKT.Kind<G, never, never, never, T[K]>;
	}> = {};

	for (const key of Object.keys(obj) as (keyof T & string)[]) {
		result[key] = transform(obj[key], key);
	}

	return result as {
		readonly [K in keyof T & string]: HKT.Kind<G, never, never, never, T[K]>;
	};
}

export function mapValuesOptional<
	F extends HKT.TypeLambda,
	G extends HKT.TypeLambda,
	T extends Record<string, unknown>,
>(
	obj:
		| {
				readonly [K in keyof T & string]: HKT.Kind<
					F,
					never,
					never,
					never,
					T[K]
				>;
		  }
		| undefined,
	transform: <V>(
		value: HKT.Kind<F, never, never, never, V>,
		key: keyof T & string,
	) => HKT.Kind<G, never, never, never, V>,
) {
	if (typeof obj === "undefined") {
		return {} as {
			readonly [K in keyof T & string]: HKT.Kind<G, never, never, never, T[K]>;
		};
	}
	return mapValues<F, G, T>(obj, transform);
}

// TODO: nowhere near type safe. Result can do anything.
export function mergeRecords<Result>(
	base: Readonly<Record<string, unknown>> | undefined,
	extra: Readonly<Record<string, unknown>> | undefined,
): Result {
	return { ...base, ...extra } as Result;
}

export const mapEffectValues =
	<
		F extends HKT.TypeLambda,
		G extends HKT.TypeLambda,
		T extends Record<string, unknown>,
	>() =>
	<E, R>(
		obj: {
			readonly [K in keyof T & string]: HKT.Kind<F, never, never, never, T[K]>;
		},
		transform: <V>(
			value: HKT.Kind<F, never, never, never, V>,
			key: keyof T & string,
		) => Effect.Effect<HKT.Kind<G, never, never, never, V>, E, R>,
	) =>
		Effect.gen(function* () {
			const result: Partial<{
				readonly [K in keyof T & string]: HKT.Kind<
					G,
					never,
					never,
					never,
					T[K]
				>;
			}> = {};
			for (const key of Object.keys(obj) as (keyof T & string)[]) {
				result[key] = yield* transform(obj[key], key);
			}
			return result as {
				readonly [K in keyof T & string]: HKT.Kind<
					G,
					never,
					never,
					never,
					T[K]
				>;
			};
		});

export const zipEffectValues =
	<
		F extends HKT.TypeLambda,
		C extends HKT.TypeLambda,
		G extends HKT.TypeLambda,
		In,
		T extends Record<string, unknown>,
	>() =>
	<E, R>(
		obj: {
			readonly [K in keyof T & string]: HKT.Kind<F, never, never, never, T[K]>;
		},
		ctx:
			| {
					readonly [K in keyof T & string]: HKT.Kind<C, In, never, never, T[K]>;
			  }
			| undefined,
		transform: <V>(
			value: HKT.Kind<F, never, never, never, V>,
			context: HKT.Kind<C, In, never, never, V>,
			key: keyof T & string,
		) => Effect.Effect<HKT.Kind<G, never, never, never, V>, E, R>,
	) =>
		Effect.gen(function* () {
			const result: Partial<{
				readonly [K in keyof T & string]: HKT.Kind<
					G,
					never,
					never,
					never,
					T[K]
				>;
			}> = {};
			if (typeof ctx === "undefined") {
				return result as {
					readonly [K in keyof T & string]: HKT.Kind<
						G,
						never,
						never,
						never,
						T[K]
					>;
				};
			}
			for (const key of Object.keys(obj) as (keyof T & string)[]) {
				result[key] = yield* transform(obj[key], ctx[key], key);
			}
			return result as {
				readonly [K in keyof T & string]: HKT.Kind<
					G,
					never,
					never,
					never,
					T[K]
				>;
			};
		});
