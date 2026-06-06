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

// Maps only the entries whose value carries a defined `schema` (the rest are skipped),
// keyed by the result type T — the schema-bearing subset. Tolerates an undefined object.
// `schema` is optional per entry, so the input is loosely typed; both the per-entry cast to
// the F-kind and the result cast live here, the same way mapValues owns its cast.
export function mapOptionalSchemaValues<
	F extends HKT.TypeLambda,
	G extends HKT.TypeLambda,
	T extends Record<string, unknown>,
>(
	// TODO: restrict with T
	obj: Record<string, { readonly schema?: unknown }> | undefined,
	transform: <V>(
		value: HKT.Kind<F, never, never, never, V>,
		key: keyof T & string,
	) => HKT.Kind<G, never, never, never, V>,
): {
	readonly [K in keyof T & string]: HKT.Kind<G, never, never, never, T[K]>;
} {
	const result: Record<string, unknown> = {};
	if (typeof obj !== "undefined") {
		for (const [key, value] of Object.entries(obj)) {
			if (typeof value.schema !== "undefined") {
				result[key] = transform(
					value as HKT.Kind<F, never, never, never, unknown>,
					key as keyof T & string,
				);
			}
		}
	}
	return result as {
		readonly [K in keyof T & string]: HKT.Kind<G, never, never, never, T[K]>;
	};
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
