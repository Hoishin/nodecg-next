import { Effect, Schema, type HKT } from "effect";

const unsafeObjectKeys = <T extends object>(obj: T) =>
	Object.keys(obj) as (keyof T & string)[];

type ApplyLambdaToObjectValues<
	F extends HKT.TypeLambda,
	Target extends Record<string, unknown>,
	Out1 = never,
	Out2 = never,
	In = unknown,
> = {
	readonly [K in keyof Target & string]: HKT.Kind<F, In, Out2, Out1, Target[K]>;
};

export const mapValues =
	<F extends HKT.TypeLambda, G extends HKT.TypeLambda>(
		transform: <Target, In = unknown>(
			value: HKT.Kind<F, In, never, never, Target>,
			key: string,
		) => HKT.Kind<G, In, never, never, Target>,
	) =>
	<Target extends Record<string, unknown>, In = unknown>(
		obj: ApplyLambdaToObjectValues<F, Target, never, never, In> | undefined,
	): ApplyLambdaToObjectValues<G, Target, never, never, In> => {
		const result: any = {};
		// TODO: handle undefined before this function is called
		if (typeof obj === "undefined") {
			return result;
		}
		for (const key of unsafeObjectKeys(obj)) {
			result[key] = transform(obj[key], key);
		}
		return result;
	};

export const mapEffectValues =
	<
		InLambda extends HKT.TypeLambda,
		OutLambda extends HKT.TypeLambda,
		Target extends Record<string, unknown>,
	>() =>
	<E, R>(
		obj: ApplyLambdaToObjectValues<InLambda, Target>,
		transform: <K extends keyof Target & string>(
			value: HKT.Kind<InLambda, unknown, never, never, Target[K]>,
			key: keyof Target & string,
		) => Effect.Effect<
			HKT.Kind<OutLambda, unknown, never, never, Target[K]>,
			E,
			R
		>,
	) =>
		Effect.gen(function* () {
			const result: Partial<ApplyLambdaToObjectValues<OutLambda, Target>> = {};
			for (const key of unsafeObjectKeys(obj)) {
				result[key] = yield* transform(obj[key], key);
			}
			return result as ApplyLambdaToObjectValues<OutLambda, Target>;
		});

export const zipEffectValues =
	<
		F extends HKT.TypeLambda,
		C extends HKT.TypeLambda,
		G extends HKT.TypeLambda,
		In,
		Target extends Record<string, unknown>,
	>() =>
	<E, R>(
		obj: ApplyLambdaToObjectValues<F, Target>,
		ctx: ApplyLambdaToObjectValues<C, Target, never, never, In> | undefined,
		transform: <K extends keyof Target & string>(
			value: HKT.Kind<F, unknown, never, never, Target[K]>,
			context: HKT.Kind<C, In, never, never, Target[K]>,
			key: keyof Target & string,
		) => Effect.Effect<HKT.Kind<G, unknown, never, never, Target[K]>, E, R>,
	) =>
		Effect.gen(function* () {
			const result: Partial<ApplyLambdaToObjectValues<G, Target>> = {};
			if (typeof ctx === "undefined") {
				return result as ApplyLambdaToObjectValues<G, Target>;
			}
			for (const key of Object.keys(obj) as (keyof Target & string)[]) {
				result[key] = yield* transform(obj[key], ctx[key], key);
			}
			return result as ApplyLambdaToObjectValues<G, Target>;
		});

type SchemaKeys<In> = {
	[K in keyof In]: In[K] extends { readonly schema: {} } ? K : never;
}[keyof In] &
	string;

export type AddedSchemas<In> = {
	readonly [K in SchemaKeys<In>]: In[K] extends {
		readonly schema: infer S extends Schema.Schema<any, any, never>;
	}
		? S
		: never;
};

export const mapSchemaValues =
	<
		Option extends { readonly schema?: Schema.Schema<any, any, never> },
		G extends HKT.TypeLambda,
	>() =>
	<In extends Record<string, Option>>(
		obj: In | undefined,
		transform: (
			value: Option & { readonly schema: Schema.Schema<any, any, never> },
			key: string,
		) => HKT.Kind<G, unknown, never, never, Schema.Schema<any, any, never>>,
	): ApplyLambdaToObjectValues<G, AddedSchemas<In>> => {
		const result: any = {};
		if (typeof obj !== "undefined") {
			for (const key of Object.keys(obj)) {
				const value = obj[key];
				if (typeof value === "undefined") {
					continue;
				}
				const schema = value.schema;
				if (typeof schema === "undefined") {
					continue;
				}
				result[key] = transform({ ...value, schema }, key);
			}
		}
		return result as ApplyLambdaToObjectValues<G, AddedSchemas<In>>;
	};

// TODO: nowhere near type safe. Result can do anything.
export function mergeRecords<Result>(
	base: Readonly<Record<string, unknown>> | undefined,
	extra: Readonly<Record<string, unknown>> | undefined,
): Result {
	return { ...base, ...extra } as Result;
}
