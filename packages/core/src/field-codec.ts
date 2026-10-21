import { cloneJson, findInheritedKey } from "@nodecg-next/internal/utils";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { getDotPath } from "@standard-schema/utils";
import { Effect, Option, Result, Schema } from "effect";
import type { WritableDeep } from "type-fest";

const decodeJson = Schema.decodeUnknownResult(Schema.Json);

export class FieldEncodeError extends Schema.TaggedError<FieldEncodeError>()(
	"FieldEncodeError",
	{
		fieldName: Schema.String,
		value: Schema.Unknown,
		cause: Schema.instanceOf(Error),
	},
) {
	override readonly message = `Failed to encode replicant "${this.fieldName}": ${this.cause.message}`;
}

export class FieldDecodeError extends Schema.TaggedError<FieldDecodeError>()(
	"FieldDecodeError",
	{
		fieldName: Schema.String,
		value: Schema.Unknown,
		cause: Schema.instanceOf(Error),
	},
) {
	override readonly message = `Failed to decode replicant "${this.fieldName}": ${this.cause.message}`;
}

const makeEffectCodec = <D>(
	name: string,
	schema: Schema.Codec<D, Schema.Json>,
) => ({
	encode: Effect.fn("encode")(function* (value: D) {
		return yield* Schema.encodeEffect(schema)(value).pipe(
			Effect.catchTag("SchemaError", (error) =>
				FieldEncodeError.make({ fieldName: name, value, cause: error }),
			),
		);
	}),
	decode: Effect.fn("decode")(function* (value: Schema.Json) {
		return yield* Schema.decodeEffect(schema)(value).pipe(
			Effect.catchTag("SchemaError", (error) =>
				FieldDecodeError.make({ fieldName: name, value, cause: error }),
			),
		);
	}),
});

class SchemaIssues extends Schema.TaggedError<SchemaIssues>()("SchemaIssues", {
	issues: Schema.Array(Schema.String),
}) {
	override readonly message = this.issues.join("\n");
}

const standardSchemaValidator =
	<D>(schema: StandardSchemaV1<unknown, D>) =>
	(value: unknown) => {
		const result = schema["~standard"].validate(value);
		if (result instanceof Promise) {
			return Result.fail(
				SchemaIssues.make({ issues: ["The schema validated asynchronously"] }),
			);
		}
		if (result.issues) {
			return Result.fail(
				SchemaIssues.make({
					issues: result.issues.map((issue) => {
						const path = getDotPath(issue);
						return path === null ? issue.message : `${path}: ${issue.message}`;
					}),
				}),
			);
		}
		return Result.succeed(result.value);
	};

const makeStandardCodec = <D>(
	name: string,
	schema: StandardSchemaV1<unknown, D>,
) => {
	const validate = standardSchemaValidator(schema);
	return {
		encode: Effect.fn("encode")(function* (value: D) {
			const wire = validate(value).pipe(Result.flatMap(decodeJson));
			if (Result.isFailure(wire)) {
				return yield* FieldEncodeError.make({
					fieldName: name,
					value,
					cause: wire.failure,
				});
			}
			return wire.success;
		}),
		decode: Effect.fn("decode")(function* (value: Schema.Json) {
			const validation = validate(value);
			if (Result.isFailure(validation)) {
				return yield* FieldDecodeError.make({
					fieldName: name,
					value,
					cause: validation.failure,
				});
			}
			return validation.success;
		}),
	};
};

export interface FieldCodec<D> {
	readonly encode: (
		value: D | WritableDeep<D>,
	) => Effect.Effect<Schema.Json, FieldEncodeError>;
	readonly decode: (value: Schema.Json) => Effect.Effect<D, FieldDecodeError>;
	readonly mutableDecode: (
		value: Schema.Json,
	) => Effect.Effect<WritableDeep<D>, FieldDecodeError>;
}

export function makeCodec<D>(
	name: string,
	schema: Schema.Codec<D, Schema.Json> | StandardSchemaV1<unknown, D>,
): FieldCodec<D> {
	const codec = Schema.isSchema(schema)
		? makeEffectCodec(name, schema)
		: makeStandardCodec(name, schema);
	const decode = Effect.fn("decode")(function* (value: Schema.Json) {
		const inheritedKey = findInheritedKey(value);
		if (Option.isSome(inheritedKey)) {
			return yield* FieldDecodeError.make({
				fieldName: name,
				value,
				cause: new Error(
					`Object key "${inheritedKey.value}" is a name every object inherits`,
				),
			});
		}
		return yield* codec.decode(value);
	});
	return {
		encode: Effect.fn("encode")(function* (value: D | WritableDeep<D>) {
			// Asserting mutable object as immutable is safe in this context
			const encoded = yield* codec.encode(value as D);
			const inheritedKey = findInheritedKey(encoded);
			if (Option.isSome(inheritedKey)) {
				return yield* FieldEncodeError.make({
					fieldName: name,
					value,
					cause: new Error(
						`Object key "${inheritedKey.value}" is a name every object inherits`,
					),
				});
			}
			return encoded;
		}),
		decode,
		mutableDecode: Effect.fn("mutableDecode")(function* (value: Schema.Json) {
			// Decode a copy because a schema may hand back parts of its input, so the result is safe to assert as mutable
			const decoded = yield* decode(cloneJson(value));
			return decoded as WritableDeep<D>;
		}),
	};
}
