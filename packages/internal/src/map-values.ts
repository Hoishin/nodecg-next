import { Effect, Schema, type HKT } from "effect";

const unsafeObjectKeys = <T extends object>(obj: T) =>
	Object.keys(obj) as (keyof T & string)[];

type ApplyLambdaToObjectValues<
	Target extends Record<string, unknown>,
	F extends HKT.TypeLambda,
	In = never,
	Out2 = never,
	Out1 = never,
> = {
	readonly [K in keyof Target & string]: HKT.Kind<F, In, Out2, Out1, Target[K]>;
};

export const mapValues =
	<F extends HKT.TypeLambda, G extends HKT.TypeLambda>(
		transform: <A>(
			value: HKT.Kind<F, never, never, never, A>,
			key: string,
		) => HKT.Kind<G, never, never, never, A>,
	) =>
	<Target extends Record<string, unknown>>(
		obj: ApplyLambdaToObjectValues<Target, F> | undefined,
	): ApplyLambdaToObjectValues<Target, G> => {
		if (typeof obj === "undefined") {
			return {} as any;
		}
		const result: any = {};
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
		obj: ApplyLambdaToObjectValues<Target, InLambda>,
		transform: <K extends keyof Target & string>(
			value: HKT.Kind<InLambda, never, never, never, Target[K]>,
			key: keyof Target & string,
		) => Effect.Effect<
			HKT.Kind<OutLambda, never, never, never, Target[K]>,
			E,
			R
		>,
	) =>
		Effect.gen(function* () {
			const result: Partial<ApplyLambdaToObjectValues<Target, OutLambda>> = {};
			for (const key of unsafeObjectKeys(obj)) {
				result[key] = yield* transform(obj[key], key);
			}
			return result as ApplyLambdaToObjectValues<Target, OutLambda>;
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
		obj: ApplyLambdaToObjectValues<Target, F>,
		ctx: ApplyLambdaToObjectValues<Target, C, In> | undefined,
		transform: <K extends keyof Target & string>(
			value: HKT.Kind<F, never, never, never, Target[K]>,
			context: HKT.Kind<C, In, never, never, Target[K]>,
			key: keyof Target & string,
		) => Effect.Effect<HKT.Kind<G, never, never, never, Target[K]>, E, R>,
	) =>
		Effect.gen(function* () {
			const result: Partial<ApplyLambdaToObjectValues<Target, G>> = {};
			if (typeof ctx === "undefined") {
				return result as ApplyLambdaToObjectValues<Target, G>;
			}
			for (const key of Object.keys(obj) as (keyof Target & string)[]) {
				result[key] = yield* transform(obj[key], ctx[key], key);
			}
			return result as ApplyLambdaToObjectValues<Target, G>;
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
		) => HKT.Kind<G, never, never, never, Schema.Schema<any, any, never>>,
	): ApplyLambdaToObjectValues<AddedSchemas<In>, G> => {
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
		return result as ApplyLambdaToObjectValues<AddedSchemas<In>, G>;
	};

// TODO: nowhere near type safe. Result can do anything.
export function mergeRecords<Result>(
	base: Readonly<Record<string, unknown>> | undefined,
	extra: Readonly<Record<string, unknown>> | undefined,
): Result {
	return { ...base, ...extra } as Result;
}
