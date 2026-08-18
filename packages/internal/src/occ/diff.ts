// Diff producer of the OCC mechanism, turning a base and a next document into
// the RFC 6902 ops that carry the change.

import { Schema } from "effect";
import stringify from "fast-json-stable-stringify";
import { create } from "jsondiffpatch";
import { format } from "jsondiffpatch/formatters/jsonpatch";
import type { JsonValue } from "type-fest";

import { ChangeOp } from "./schema.ts";

const validateChanges = Schema.validateEither(Schema.Array(ChangeOp));

const differ = create({
	objectHash: (item: object) => stringify(item),
	arrays: { detectMove: true },
});

export const diffPatch = (base: JsonValue, next: JsonValue) =>
	validateChanges(format(differ.diff(base, next)));
