import { type HKT } from "effect";
import { describe, expect, expectTypeOf, test } from "vitest";

import { mapSchemaValues } from "./map-schema-values.ts";

interface ArrayLambda extends HKT.TypeLambda {
	readonly type: ReadonlyArray<this["Target"]>;
}
type SchemaBox<T> = { readonly schema: T };
interface SchemaBoxLambda extends HKT.TypeLambda {
	readonly type: SchemaBox<this["Target"]>;
}

describe("mapSchemaValues", () => {
	test("maps only the entries carrying a schema, keyed by the schema-bearing subset", () => {
		const result = mapSchemaValues<SchemaBoxLambda, ArrayLambda>()(
			{ a: { schema: 1 }, b: { schema: "two" }, skip: {} },
			(value) => [value.schema],
		);
		expectTypeOf(result).toEqualTypeOf<{
			readonly a: ReadonlyArray<number>;
			readonly b: ReadonlyArray<string>;
		}>();
		expect(result).toEqual({ a: [1], b: ["two"] });
	});

	test("passes the key to the transform, skipping schema-less entries", () => {
		const keys: string[] = [];
		mapSchemaValues<SchemaBoxLambda, ArrayLambda>()(
			{ a: { schema: 1 }, b: { schema: 2 }, skip: {} },
			(value, key) => {
				keys.push(key);
				return [value.schema];
			},
		);
		expect(keys.sort()).toEqual(["a", "b"]);
	});

	test("returns an empty object for an undefined input", () => {
		const input: Record<string, { readonly schema?: unknown }> | undefined =
			undefined;
		const result = mapSchemaValues<SchemaBoxLambda, ArrayLambda>()(
			input,
			(value) => [value.schema],
		);
		expect(result).toEqual({});
	});

	test("rejects a value that is not option-shaped", () => {
		mapSchemaValues<SchemaBoxLambda, ArrayLambda>()(
			// @ts-expect-error 123 is not `{ schema?: unknown }`
			{ bogus: 123 },
			(value) => [value.schema],
		);
	});
});
