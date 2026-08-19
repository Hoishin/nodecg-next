import { describe, expect, test } from "vitest";

import { computeTestHash } from "./hash.ts";

describe("computeTestHash", () => {
	test("equal values hash equal regardless of key order", () => {
		expect(computeTestHash({ b: [1, { z: 1, y: 2 }], a: null })).toBe(
			computeTestHash({ a: null, b: [1, { y: 2, z: 1 }] }),
		);
	});

	test("different values hash different", () => {
		expect(computeTestHash({ a: 1 })).not.toBe(computeTestHash({ a: 2 }));
		expect(computeTestHash([1, 2])).not.toBe(computeTestHash([2, 1]));
		expect(computeTestHash("1")).not.toBe(computeTestHash(1));
		expect(computeTestHash("😀")).not.toBe(computeTestHash("😃"));
	});

	test("is 128 bits of hex", () => {
		expect(computeTestHash(null)).toMatch(/^[0-9a-f]{32}$/);
	});
});
