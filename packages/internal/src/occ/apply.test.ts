import { Either } from "effect";
import type { JsonValue } from "type-fest";
import { assert, describe, expect, test } from "vitest";

import { ApplyFailure, applyPatch } from "./apply.ts";
import type { Patch } from "./schema.ts";

const applied = (value: JsonValue, patch: Patch) => {
	return applyPatch(value, patch).pipe(Either.getOrThrow);
};

const failure = (value: JsonValue, patch: Patch) => {
	return applyPatch(value, patch).pipe(Either.flip, Either.getOrThrow);
};

describe("applyPatch", () => {
	describe("replace", () => {
		test("object key and array element", () => {
			expect(
				applied({ a: 1, arr: [1, 2] }, [
					{ op: "replace", path: "/a", value: 9 },
					{ op: "replace", path: "/arr/1", value: 5 },
				]),
			).toEqual({ a: 9, arr: [1, 5] });
		});

		test("whole document", () => {
			expect(
				applied({ a: 1 }, [{ op: "replace", path: "", value: [1] }]),
			).toEqual([1]);
		});

		test("missing object key fails (concurrent remove surfaces as conflict)", () => {
			expect(
				failure({ a: 1 }, [{ op: "replace", path: "/b", value: 1 }]).cause,
			).toEqual(ApplyFailure.MissingKey({ key: "b" }));
		});

		test("array index past the end fails", () => {
			expect(
				failure([1], [{ op: "replace", path: "/1", value: 2 }]).cause,
			).toEqual(ApplyFailure.IndexOutOfBounds({ index: 1 }));
		});

		test("non-canonical array index fails", () => {
			expect(
				failure([1], [{ op: "replace", path: "/01", value: 2 }]).cause,
			).toEqual(ApplyFailure.InvalidIndex({ token: "01" }));
		});

		test("a primitive is not a container", () => {
			expect(
				failure({ a: 1 }, [{ op: "replace", path: "/a/b", value: 2 }]).cause,
			).toEqual(ApplyFailure.NonContainer({ token: "b" }));
		});

		test("the failing op is reported", () => {
			expect(
				failure({ a: 1 }, [
					{ op: "replace", path: "/a", value: 9 },
					{ op: "replace", path: "/missing", value: 1 },
				]).op,
			).toEqual({ op: "replace", path: "/missing", value: 1 });
		});
	});

	describe("pointer escaping", () => {
		test("~1 and ~0 address keys containing / and ~", () => {
			expect(
				applied({ "a/b": 1, "x~y": 2 }, [
					{ op: "replace", path: "/a~1b", value: 3 },
					{ op: "replace", path: "/x~0y", value: 4 },
				]),
			).toEqual({ "a/b": 3, "x~y": 4 });
		});
	});

	describe("isolation", () => {
		test("the input is never mutated, even by a successful apply", () => {
			const input = { a: { b: 1 } };
			const result = applyPatch(input, [
				{ op: "replace", path: "/a/b", value: 2 },
			]);
			assert(Either.isRight(result));
			expect(input).toEqual({ a: { b: 1 } });
		});

		test("a mid-patch failure leaves no partial result observable", () => {
			const input = { a: 1, b: 1 };
			const result = applyPatch(input, [
				{ op: "replace", path: "/a", value: 9 },
				{ op: "replace", path: "/missing", value: 1 },
			]);
			assert(Either.isLeft(result));
			expect(input).toEqual({ a: 1, b: 1 });
		});

		test("written values do not alias the patch", () => {
			const value = { nested: 1 };
			const result = applyPatch({ v: 0 }, [
				{ op: "replace", path: "/v", value },
			]);
			assert(Either.isRight(result));
			value.nested = 2;
			expect(result.right).toEqual({ v: { nested: 1 } });
		});

		test("prototype members are not addressable", () => {
			expect(
				failure({}, [{ op: "replace", path: "/constructor", value: 1 }]).cause,
			).toEqual(ApplyFailure.MissingKey({ key: "constructor" }));
		});
	});
});
