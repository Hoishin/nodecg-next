// Diff producer of the OCC mechanism, turning a base and a next document into
// the RFC 6902 ops that carry the change.

import { Schema } from "effect";
import stringify from "fast-json-stable-stringify";
import { create } from "jsondiffpatch";
import { format } from "jsondiffpatch/formatters/jsonpatch";
import type { JsonValue } from "type-fest";

import { ChangeOp } from "./schema.ts";

const isChangeOnly = Schema.is(Schema.Array(ChangeOp));

const differ = create({
	objectHash: (item: object) => stringify(item),
	arrays: { detectMove: true },
});

export const diffPatch = (
	base: JsonValue,
	next: JsonValue,
): ReadonlyArray<ChangeOp> => {
	const delta = differ.diff(base, next);
	if (typeof delta === "undefined") {
		return [];
	}
	const ops = format(delta);
	// Moves are not supported yet
	return isChangeOnly(ops) ? ops : [{ op: "replace", path: "", value: next }];
};
