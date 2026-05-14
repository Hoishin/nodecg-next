import { mapValues } from "@nodecg/internal";
import { Data, Effect, type HKT, Schema } from "effect";
import type { JsonValue } from "type-fest";

export class StateValidationError extends Data.TaggedError(
	"StateValidationError",
)<{
	readonly name: string;
	readonly cause: string;
}> {
	override get message() {
		return `Failed to validate state "${this.name}": ${this.cause}`;
	}
}

interface StateOption<S extends Schema.Schema<any, any, never>> {
	schema: [Schema.Schema.Encoded<S>] extends [JsonValue] ? S : never;
	initialValue: () => Schema.Schema.Type<S>;
}

export interface StateDefinition<Decoded> {
	readonly name: string;
	readonly getInitial: () => Decoded;
	readonly encode: (
		value: Decoded,
	) => Effect.Effect<JsonValue, StateValidationError>;
	readonly decode: (
		value: unknown,
	) => Effect.Effect<Decoded, StateValidationError>;
}

export interface StateManifest<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
> {
	namespace: string;
	definitions: {
		[K in keyof Definitions & string]: StateDefinition<
			Schema.Schema.Type<Definitions[K]>
		>;
	};
}

function implementDefinition<S extends Schema.Schema<any, JsonValue, never>>(
	name: string,
	{ schema, initialValue }: StateOption<S>,
): StateDefinition<Schema.Schema.Type<S>> {
	return {
		name,
		getInitial: initialValue,
		encode: Effect.fn("encode")(function* (value: Schema.Schema.Type<S>) {
			return yield* Schema.encode(schema)(value).pipe(
				Effect.catchTag(
					"ParseError",
					(error) => new StateValidationError({ name, cause: error.message }),
				),
			);
		}),
		decode: Effect.fn("decode")(function* (value: unknown) {
			return yield* Schema.decodeUnknown(schema)(value).pipe(
				Effect.catchTag(
					"ParseError",
					(error) => new StateValidationError({ name, cause: error.message }),
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
>(
	namespace: string,
	defs: {
		[K in keyof Definitions & string]: StateOption<Definitions[K]>;
	},
): StateManifest<Definitions> {
	return {
		namespace,
		definitions: mapValues<
			StateOptionLambda,
			StateDefinitionLambda,
			Definitions
		>(defs, (options, name) => implementDefinition(name, options)),
	};
}
