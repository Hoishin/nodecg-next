import { Result } from "effect";
import { assert, describe, expect, test } from "vitest";

import { buildRelativeUrl, parseRelativeUrl } from "./relative-url.ts";

describe("parseRelativeUrl", () => {
	test("parses a relative url", () => {
		expect(parseRelativeUrl("/a/b?x=1")).toEqual(
			Result.succeed({ pathname: "/a/b", search: "?x=1" }),
		);
	});

	test("fails on an unparsable url", () => {
		const result = parseRelativeUrl("//[bad");
		assert(Result.isFailure(result));
		expect(result.failure.url).toBe("//[bad");
		expect(result.failure.message).toBe('URL "//[bad" is malformed');
	});
});

describe("buildRelativeUrl", () => {
	test("sets encoded params, keeping existing ones", () => {
		expect(buildRelativeUrl("/a/b?x=1", { y: "/z?w" })).toEqual(
			Result.succeed("/a/b?y=%2Fz%3Fw&x=1"),
		);
	});
});
