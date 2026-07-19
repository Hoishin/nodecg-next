import { testEffect } from "@nodecg/internal/test-utils";
import { ConfigError, ConfigProvider, Effect } from "effect";
import { describe, expect, test } from "vitest";

import { config } from "./server-config.ts";

const readBaseUrl = (env: ReadonlyArray<readonly [string, string]>) =>
	config.baseUrl.pipe(
		Effect.withConfigProvider(ConfigProvider.fromMap(new Map(env))),
	);

describe("baseUrl", () => {
	test(
		"defaults to localhost on the configured port at root",
		testEffect(
			Effect.gen(function* () {
				expect(yield* readBaseUrl([])).toEqual({
					href: "http://localhost:3000",
					pathname: "/",
				});
				expect(yield* readBaseUrl([["PORT", "8080"]])).toEqual({
					href: "http://localhost:8080",
					pathname: "/",
				});
			}),
		),
	);

	test(
		"a bare origin resolves to root",
		testEffect(
			Effect.gen(function* () {
				expect(
					yield* readBaseUrl([["NODECG_BASE_URL", "http://host"]]),
				).toEqual({ href: "http://host/", pathname: "/" });
			}),
		),
	);

	test(
		"exposes the configured sub-path",
		testEffect(
			Effect.gen(function* () {
				expect(
					yield* readBaseUrl([["NODECG_BASE_URL", "http://host/foo"]]),
				).toEqual({ href: "http://host/foo", pathname: "/foo" });
			}),
		),
	);

	test(
		"strips a trailing slash from the pathname",
		testEffect(
			Effect.gen(function* () {
				expect(
					yield* readBaseUrl([["NODECG_BASE_URL", "http://host/foo/"]]),
				).toEqual({ href: "http://host/foo/", pathname: "/foo" });
				expect(
					yield* readBaseUrl([["NODECG_BASE_URL", "http://host/a/b/"]]),
				).toEqual({ href: "http://host/a/b/", pathname: "/a/b" });
			}),
		),
	);

	test(
		"rejects a malformed url instead of falling back to the default",
		testEffect(
			Effect.gen(function* () {
				const error = yield* readBaseUrl([
					["NODECG_BASE_URL", "not a url"],
				]).pipe(Effect.flip);
				expect(ConfigError.isConfigError(error)).toBe(true);
			}),
		),
	);
});
