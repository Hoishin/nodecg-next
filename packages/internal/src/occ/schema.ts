// Schema contracts for the replicant patch wire between client and server
// based on RFC 6901 and RFC 6902

import { HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

import { JsonValueSchema } from "../utils/json-value-schema.ts";

// RFC 6901: JSON path pointers
export const Pointer = Schema.Union(
	Schema.Literal(""),
	Schema.TemplateLiteral("/", Schema.String),
);
export type Pointer = typeof Pointer.Type;

// RFC 6902: JSON patch ops
export const ReplaceOp = Schema.Struct({
	op: Schema.Literal("replace"),
	path: Pointer,
	value: JsonValueSchema,
});
export type ReplaceOp = typeof ReplaceOp.Type;

// Patch is a collection of ops
export const Patch = Schema.NonEmptyArray(ReplaceOp);
export type Patch = typeof Patch.Type;

export class PatchNotApplicable extends Schema.TaggedError<PatchNotApplicable>()(
	"PatchNotApplicable",
	{ path: Pointer, reason: Schema.String },
	HttpApiSchema.annotations({ status: 422 }),
) {
	override readonly message = `Patch operation at "${this.path}" cannot apply: ${this.reason}`;
}
