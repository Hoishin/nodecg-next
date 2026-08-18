import { Schema } from "effect";
import { describe, expect, test } from "vitest";

import { Patch, Pointer, ReplaceOp } from "./schema.ts";

const decodeOp = Schema.decodeUnknownSync(ReplaceOp);
const decodePatch = Schema.decodeUnknownSync(Patch);
const decodePointer = Schema.decodeUnknownSync(Pointer);

describe("Pointer", () => {
	test("accepts the root pointer and /-prefixed pointers", () => {
		expect(decodePointer("")).toBe("");
		expect(decodePointer("/a/0/b")).toBe("/a/0/b");
	});

	test("rejects a pointer missing the leading slash", () => {
		expect(() => decodePointer("a/b")).toThrow();
	});
});

describe("ReplaceOp", () => {
	test("decodes root and field-level replaces", () => {
		expect(decodeOp({ op: "replace", path: "", value: [1] })).toEqual({
			op: "replace",
			path: "",
			value: [1],
		});
		expect(decodeOp({ op: "replace", path: "/a/0", value: null })).toEqual({
			op: "replace",
			path: "/a/0",
			value: null,
		});
	});
});

describe("Patch", () => {
	test("decodes a multi-op patch and rejects an empty one", () => {
		expect(
			decodePatch([
				{ op: "replace", path: "/a", value: 2 },
				{ op: "replace", path: "/b", value: 3 },
			]),
		).toHaveLength(2);
		expect(() => decodePatch([])).toThrow();
	});
});
