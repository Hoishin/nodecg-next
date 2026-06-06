import { type HKT } from "effect";

type SchemaKeys<In> = {
	[K in keyof In]: In[K] extends { readonly schema: {} } ? K : never;
}[keyof In] &
	string;

export type AddedSchemas<In> = {
	readonly [K in SchemaKeys<In>]: In[K] extends { readonly schema: infer S }
		? S
		: never;
};

export const mapSchemaValues =
	<F extends HKT.TypeLambda, G extends HKT.TypeLambda>() =>
	<In extends Record<string, { readonly schema?: unknown }>>(
		obj: In | undefined,
		transform: <V>(
			value: HKT.Kind<F, never, never, never, V>,
			key: keyof AddedSchemas<In> & string,
		) => HKT.Kind<G, never, never, never, V>,
	): {
		readonly [K in keyof AddedSchemas<In> & string]: HKT.Kind<
			G,
			never,
			never,
			never,
			AddedSchemas<In>[K]
		>;
	} => {
		const result: Record<string, unknown> = {};
		if (typeof obj !== "undefined") {
			for (const [key, value] of Object.entries(obj)) {
				if (typeof value.schema !== "undefined") {
					result[key] = transform(
						value as HKT.Kind<F, never, never, never, unknown>,
						key as keyof AddedSchemas<In> & string,
					);
				}
			}
		}
		return result as {
			readonly [K in keyof AddedSchemas<In> & string]: HKT.Kind<
				G,
				never,
				never,
				never,
				AddedSchemas<In>[K]
			>;
		};
	};
