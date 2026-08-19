// Schema contracts for the replicant patch wire between client and server
// based on RFC 6901 and RFC 6902, extended with a non-standard test-hash precondition

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
export const AddOp = Schema.Struct({
	op: Schema.Literal("add"),
	path: Pointer,
	value: JsonValueSchema,
});
export type AddOp = typeof AddOp.Type;

export const RemoveOp = Schema.Struct({
	op: Schema.Literal("remove"),
	path: Pointer,
});
export type RemoveOp = typeof RemoveOp.Type;

export const ReplaceOp = Schema.Struct({
	op: Schema.Literal("replace"),
	path: Pointer,
	value: JsonValueSchema,
});
export type ReplaceOp = typeof ReplaceOp.Type;

export const MoveOp = Schema.Struct({
	op: Schema.Literal("move"),
	from: Pointer,
	path: Pointer,
});
export type MoveOp = typeof MoveOp.Type;

export const ChangeOp = Schema.Union(AddOp, RemoveOp, ReplaceOp, MoveOp);
export type ChangeOp = typeof ChangeOp.Type;

// Non-standard precondition
export const TestHashOp = Schema.Struct({
	op: Schema.Literal("test-hash"),
	path: Pointer,
	hash: Schema.String,
});
export type TestHashOp = typeof TestHashOp.Type;

export const PatchOp = Schema.Union(ChangeOp, TestHashOp);
export type PatchOp = typeof PatchOp.Type;

// Patch is a collection of ops
export const Patch = Schema.NonEmptyArray(PatchOp);
export type Patch = typeof Patch.Type;

export class PatchNotApplicable extends Schema.TaggedError<PatchNotApplicable>()(
	"PatchNotApplicable",
	{ path: Pointer, reason: Schema.String },
	HttpApiSchema.annotations({ status: 422 }),
) {
	override readonly message = `Patch operation at "${this.path}" cannot apply: ${this.reason}`;
}

export class RevisionConflict extends Schema.TaggedError<RevisionConflict>()(
	"RevisionConflict",
	{ value: JsonValueSchema, revision: Schema.Number, reason: Schema.String },
	HttpApiSchema.annotations({ status: 409 }),
) {
	override readonly message = `Patch conflicts with a newer revision ${this.revision}: ${this.reason}`;
}
