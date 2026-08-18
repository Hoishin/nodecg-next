import { Schema } from "effect";
import { describe, expect, test } from "vitest";

import { ChangeOp, Patch, Pointer } from "./schema.ts";

const decodeOp = Schema.decodeUnknownSync(ChangeOp);
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

describe("ChangeOp", () => {
	test("decodes every op shape", () => {
		expect(decodeOp({ op: "add", path: "/a", value: null })).toEqual({
			op: "add",
			path: "/a",
			value: null,
		});
		expect(decodeOp({ op: "remove", path: "/a/0" })).toEqual({
			op: "remove",
			path: "/a/0",
		});
		expect(decodeOp({ op: "replace", path: "", value: [1] })).toEqual({
			op: "replace",
			path: "",
			value: [1],
		});
		expect(decodeOp({ op: "move", from: "/a/1", path: "/a/0" })).toEqual({
			op: "move",
			from: "/a/1",
			path: "/a/0",
		});
	});

	test("rejects ops outside the wire vocabulary", () => {
		expect(() => decodeOp({ op: "copy", from: "/a", path: "/b" })).toThrow();
		expect(() => decodeOp({ op: "test", path: "/a", value: 1 })).toThrow();
	});
});

describe("Patch", () => {
	test("decodes a mixed multi-op patch and rejects an empty one", () => {
		expect(
			decodePatch([
				{ op: "replace", path: "/a", value: 2 },
				{ op: "add", path: "/b", value: 3 },
				{ op: "remove", path: "/c" },
			]),
		).toHaveLength(3);
		expect(() => decodePatch([])).toThrow();
	});
});
