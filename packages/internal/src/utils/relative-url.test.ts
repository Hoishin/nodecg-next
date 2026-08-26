import { Either } from "effect";
import { assert, describe, expect, test } from "vitest";

import { buildRelativeUrl, parseRelativeUrl } from "./relative-url.ts";

describe("parseRelativeUrl", () => {
	test("parses a relative url", () => {
		expect(parseRelativeUrl("/a/b?x=1")).toEqual(
			Either.right({ pathname: "/a/b", search: "?x=1" }),
		);
	});

	test("fails on an unparsable url", () => {
		const result = parseRelativeUrl("//[bad");
		assert(Either.isLeft(result));
		expect(result.left.url).toBe("//[bad");
		expect(result.left.message).toBe('URL "//[bad" is malformed');
	});
});

describe("buildRelativeUrl", () => {
	test("sets encoded params, keeping existing ones", () => {
		expect(buildRelativeUrl("/a/b?x=1", { y: "/z?w" })).toEqual(
			Either.right("/a/b?y=%2Fz%3Fw&x=1"),
		);
	});
});
