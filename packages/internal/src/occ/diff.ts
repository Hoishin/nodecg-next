// Diff producer of the OCC mechanism, turning a base and a next document into
// the RFC 6902 ops that carry the change.

import { Schema } from "effect";
import stringify from "fast-json-stable-stringify";
import { create } from "jsondiffpatch";
import { format } from "jsondiffpatch/formatters/jsonpatch";
import type { JsonValue } from "type-fest";

import { ReplaceOp } from "./schema.ts";

const isReplaceOnly = Schema.is(Schema.Array(ReplaceOp));

const differ = create({
	objectHash: (item: object) => stringify(item),
	arrays: { detectMove: true },
});

export const diffPatch = (
	base: JsonValue,
	next: JsonValue,
): ReadonlyArray<ReplaceOp> => {
	const delta = differ.diff(base, next);
	if (typeof delta === "undefined") {
		return [];
	}
	const ops = format(delta);
	// Only supports replace ops for now
	return isReplaceOnly(ops) ? ops : [{ op: "replace", path: "", value: next }];
};
