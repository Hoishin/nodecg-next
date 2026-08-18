import { Either } from "effect";
import type { JsonValue } from "type-fest";
import { assert, describe, expect, test } from "vitest";

import { applyPatch } from "./apply.ts";
import { diffPatch } from "./diff.ts";

const roundTrip = (base: JsonValue, next: JsonValue) => {
	const result = applyPatch(base, diffPatch(base, next));
	assert(Either.isRight(result));
	expect(result.right).toEqual(next);
};

const documentReplace = (next: JsonValue) => [
	{ op: "replace", path: "", value: next },
];

describe("diffPatch", () => {
	test("no change yields an empty patch", () => {
		expect(diffPatch({ a: 1 }, { a: 1 })).toEqual([]);
	});

	test("an object edit ships only the changed field", () => {
		expect(diffPatch({ a: 1, b: "x" }, { a: 2, b: "x" })).toEqual([
			{ op: "replace", path: "/a", value: 2 },
		]);
	});

	test("disjoint object edits ship one op each", () => {
		expect(diffPatch({ a: 1, b: 2 }, { a: 9, b: 8 })).toEqual([
			{ op: "replace", path: "/a", value: 9 },
			{ op: "replace", path: "/b", value: 8 },
		]);
	});

	test("a nested edit addresses the nested path", () => {
		expect(diffPatch({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toEqual([
			{ op: "replace", path: "/a/b/c", value: 2 },
		]);
	});

	test("a long string change is a plain replace, not a text delta", () => {
		const long = "a".repeat(120);
		expect(diffPatch({ t: long }, { t: `${long}b` })).toEqual([
			{ op: "replace", path: "/t", value: `${long}b` },
		]);
	});

	test("round-trips a field edit", () => {
		roundTrip({ a: { b: 1 }, c: "x" }, { a: { b: 2 }, c: "x" });
	});

	describe("structural change", () => {
		test("a new key ships as an add", () => {
			expect(diffPatch({ a: 1 }, { a: 1, b: 2 })).toEqual([
				{ op: "add", path: "/b", value: 2 },
			]);
			roundTrip({ a: 1 }, { a: 1, b: 2 });
		});

		test("sibling adds ship one op each", () => {
			expect(diffPatch({ a: 1 }, { a: 1, b: 2, c: 3 })).toEqual([
				{ op: "add", path: "/b", value: 2 },
				{ op: "add", path: "/c", value: 3 },
			]);
		});

		test("a removed key ships as a remove", () => {
			expect(diffPatch({ a: 1, b: 2 }, { a: 1 })).toEqual([
				{ op: "remove", path: "/b" },
			]);
			roundTrip({ a: 1, b: 2 }, { a: 1 });
		});

		test("an array append ships as an add at the end", () => {
			expect(diffPatch([1, 2], [1, 2, 3])).toEqual([
				{ op: "add", path: "/2", value: 3 },
			]);
			roundTrip([1, 2], [1, 2, 3]);
		});

		test("an array removal ships as one remove, not a positional cascade", () => {
			expect(diffPatch([1, 2, 3], [1, 3])).toEqual([
				{ op: "remove", path: "/1" },
			]);
			roundTrip([1, 2, 3], [1, 3]);
		});

		test("a nested append addresses the nested array", () => {
			expect(
				diffPatch({ p: { list: ["x"] } }, { p: { list: ["x", "y"] } }),
			).toEqual([{ op: "add", path: "/p/list/1", value: "y" }]);
		});

		test("an edited array element ships whole, as the content hash matches by content", () => {
			const base = [
				{ id: "a", v: 1 },
				{ id: "b", v: 2 },
			];
			const next = [
				{ id: "a", v: 1 },
				{ id: "b", v: 9 },
			];
			expect(diffPatch(base, next)).toEqual([
				{ op: "remove", path: "/1" },
				{ op: "add", path: "/1", value: { id: "b", v: 9 } },
			]);
			roundTrip(base, next);
		});

		test("a change of the document's own type is a root replace", () => {
			expect(diffPatch({ a: 1 }, [1])).toEqual(documentReplace([1]));
			roundTrip(5, { a: 1 });
		});
	});

	describe("a reorder falls back to a document replace, until moves reach the wire", () => {
		test("an array reorder", () => {
			const base = [{ id: "a" }, { id: "b" }, { id: "c" }];
			const next = [{ id: "c" }, { id: "b" }, { id: "a" }];
			expect(diffPatch(base, next)).toEqual(documentReplace(next));
			roundTrip(base, next);
		});
	});
});
