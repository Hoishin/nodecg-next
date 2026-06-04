import { mapValues, mapValuesOptional } from "@nodecg/internal";
import { Data, Effect, type HKT, Schema } from "effect";
import type { JsonValue } from "type-fest";

export class StateEncodeError extends Data.TaggedError("StateEncodeError")<{
	readonly fieldName: string;
	readonly value: unknown;
	readonly cause: Error;
}> {
	override readonly message = `Failed to encode state "${this.fieldName}": ${this.cause.message}`;
}

export class StateDecodeError extends Data.TaggedError("StateDecodeError")<{
	readonly fieldName: string;
	readonly value: JsonValue;
	readonly cause: Error;
}> {
	override readonly message = `Failed to decode state "${this.fieldName}": ${this.cause.message}`;
}

interface StateOption<S extends Schema.Schema<any, any, never>> {
	schema: [Schema.Schema.Encoded<S>] extends [JsonValue] ? S : never;
}

export interface StateDefinition<Decoded> {
	readonly name: string;
	readonly encode: (
		value: Decoded,
	) => Effect.Effect<JsonValue, StateEncodeError>;
	readonly decode: (
		value: JsonValue,
	) => Effect.Effect<Decoded, StateDecodeError>;
}

export interface StateManifest<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
> {
	namespace: string;
	definitions: {
		[K in keyof Definitions & string]: StateDefinition<
			Schema.Schema.Type<Definitions[K]>
		>;
	};
	computed: {
		[K in keyof Computed & string]: StateDefinition<
			Schema.Schema.Type<Computed[K]>
		>;
	};
}

function implementDefinition<S extends Schema.Schema<any, JsonValue, never>>(
	name: string,
	{ schema }: StateOption<S>,
): StateDefinition<Schema.Schema.Type<S>> {
	return {
		name,
		encode: Effect.fn("encode")(function* (value: Schema.Schema.Type<S>) {
			return yield* Schema.encode(schema)(value).pipe(
				Effect.catchTag(
					"ParseError",
					(error) =>
						new StateEncodeError({ fieldName: name, value, cause: error }),
				),
			);
		}),
		decode: Effect.fn("decode")(function* (value: JsonValue) {
			return yield* Schema.decode(schema)(value).pipe(
				Effect.catchTag(
					"ParseError",
					(error) =>
						new StateDecodeError({ fieldName: name, value, cause: error }),
				),
			);
		}),
	};
}

interface StateOptionLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateOption<this["Target"]>;
}

interface StateDefinitionLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateDefinition<Schema.Schema.Type<this["Target"]>>;
}

export function defineState<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
>(
	namespace: string,
	defs: {
		[K in keyof Definitions & string]: StateOption<Definitions[K]>;
	},
	...[options]: [keyof Computed] extends [never]
		? [options?: { computed?: never }]
		: [
				options: {
					computed: {
						[K in keyof Computed & string]: StateOption<Computed[K]>;
					};
				},
			]
): StateManifest<Definitions, Computed> {
	return {
		namespace,
		definitions: mapValues<
			StateOptionLambda,
			StateDefinitionLambda,
			Definitions
		>(defs, (option, name) => implementDefinition(name, option)),
		computed: mapValuesOptional<
			StateOptionLambda,
			StateDefinitionLambda,
			Computed
		>(options?.computed, (option, name) => implementDefinition(name, option)),
	};
}
