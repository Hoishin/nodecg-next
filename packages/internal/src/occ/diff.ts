// Diff producer of the OCC mechanism, turning a base and a next document into
// the RFC 6902 ops that carry the change.

import { Data, Either, Schema } from "effect";
import type { ParseResult } from "effect";
import stringify from "fast-json-stable-stringify";
import { create } from "jsondiffpatch";
import { format } from "jsondiffpatch/formatters/jsonpatch";
import type { JsonValue } from "type-fest";

import { cloneJson, type MutableJson } from "../utils/clone.ts";
import { type ApplyFailure, applyChangeOp, getAtPointer } from "./apply.ts";
import { computeTestHash } from "./hash.ts";
import {
	type AddOp,
	ChangeOp,
	type PatchOp,
	Pointer,
	type TestHashOp,
} from "./schema.ts";

export type DiffFailure = Data.TaggedEnum<{
	UnknownOp: { readonly cause: ParseResult.ParseError };
	ReplayDisagreement: {
		readonly op: ChangeOp;
		readonly cause: ApplyFailure;
	};
}>;
export const DiffFailure = Data.taggedEnum<DiffFailure>();

const validateChanges = Schema.validateEither(Schema.Array(ChangeOp));
const isPointer = Schema.is(Pointer);

const differ = create({
	objectHash: (item: object) => stringify(item),
	arrays: { detectMove: true },
});

export const diffPatch = (base: JsonValue, next: JsonValue) =>
	validateChanges(format(differ.diff(base, next)));

// Diff formatter does not use the append form "-"
const toAppendForm = (doc: MutableJson, op: AddOp) => {
	const cut = op.path.lastIndexOf("/");
	const parentPath = op.path.slice(0, cut);
	if (!isPointer(parentPath)) {
		return op;
	}
	const parent = getAtPointer(doc, parentPath);
	if (Either.isLeft(parent) || !Array.isArray(parent.right)) {
		return op;
	}
	if (String(parent.right.length) !== op.path.slice(cut + 1)) {
		return op;
	}
	return { op: op.op, path: `${parentPath}/-` as const, value: op.value };
};

// Only an existing target gets a precondition, so concurrent adds of different new keys cannot false-conflict
const signOp = (doc: MutableJson, op: ChangeOp) => {
	const target = op.op === "move" ? op.from : op.path;
	const seen = getAtPointer(doc, target);
	if (Either.isLeft(seen)) {
		return [];
	}
	const signature: TestHashOp = {
		op: "test-hash",
		path: target,
		hash: computeTestHash(seen.right),
	};
	return [signature];
};

const signChanges = (
	base: JsonValue,
	changes: ReadonlyArray<ChangeOp>,
): Either.Either<ReadonlyArray<PatchOp>, DiffFailure> => {
	const signed: PatchOp[] = [];
	let doc = cloneJson(base);
	for (const change of changes) {
		const op = change.op === "add" ? toAppendForm(doc, change) : change;
		signed.push(...signOp(doc, op), op);
		const applied = applyChangeOp(doc, op);
		if (Either.isLeft(applied)) {
			return Either.left(
				DiffFailure.ReplayDisagreement({ op, cause: applied.left }),
			);
		}
		doc = applied.right;
	}
	return Either.right(signed);
};

export const diffSignedPatch = (base: JsonValue, next: JsonValue) =>
	diffPatch(base, next).pipe(
		Either.mapLeft((cause) => DiffFailure.UnknownOp({ cause })),
		Either.flatMap((changes) => signChanges(base, changes)),
	);
