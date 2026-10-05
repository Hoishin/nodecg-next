import { Authentication } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { ConfigProvider, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";

import { buildClient, login, services } from "./setup.ts";

const test = testLayer(
	Layer.merge(
		services,
		ConfigProvider.layer(
			ConfigProvider.fromEnvRecord({ SESSION_RENEW_INTERVAL: "1 hour" }),
		),
	),
);

const meUrl = "http://x/api/internal/me";

const operator = Authentication.make({ issuer: "dev", subject: "operator" });

describe("renewal", () => {
	test(
		"no cookie within the renew interval",
		Effect.gen(function* () {
			const client = yield* buildClient;

			const asOperator = yield* login(client, operator);
			yield* TestClock.adjust("30 minutes");

			const res = yield* asOperator.get(meUrl);
			expect(res.status).toBe(200);
			expect(res.headers["set-cookie"]).toBeUndefined();
		}),
	);

	test(
		"renews the cookie past the renew interval",
		Effect.gen(function* () {
			const client = yield* buildClient;

			const asOperator = yield* login(client, operator);
			yield* TestClock.adjust("2 hours");

			const res = yield* asOperator.get(meUrl);
			expect(res.status).toBe(200);
			expect(res.headers["set-cookie"]).toMatch(
				/^nodecg\.sid=[^;]+; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/,
			);
		}),
	);
});
