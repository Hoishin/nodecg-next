import { NodeHttpServer } from "@effect/platform-node";
import { defineNamespace } from "@nodecg-next/core";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect, FileSystem, Path } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";
import { describe, expect } from "vitest";

import {
	type FrontendConfig,
	implementNamespace,
} from "../implement-namespace.ts";
import { frontendRoutes } from "./frontend-serving.ts";

const test = testLayer(NodeHttpServer.layerHttpServices);

const manifest = defineNamespace("ns", {});

const fixtures = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = yield* fs.makeTempDirectoryScoped();
	const first = path.join(root, "first");
	const second = path.join(root, "second");
	yield* fs.makeDirectory(first);
	yield* fs.makeDirectory(second);
	yield* fs.writeFileString(path.join(first, "index.html"), "first index");
	yield* fs.writeFileString(path.join(first, "about.html"), "about page");
	yield* fs.writeFileString(path.join(first, "app.js"), "app module");
	yield* fs.writeFileString(path.join(first, "shared.txt"), "from first");
	yield* fs.writeFileString(path.join(second, "widget.js"), "widget module");
	yield* fs.makeDirectory(path.join(second, "docs"));
	yield* fs.writeFileString(
		path.join(second, "docs", "index.html"),
		"docs index",
	);
	yield* fs.writeFileString(path.join(second, "shared.txt"), "from second");
	yield* fs.writeFileString(path.join(root, "secret.txt"), "secret");
	return { root, first, second };
});

const serve = Effect.fn(function* (frontend: FrontendConfig) {
	const handler = yield* HttpRouter.toHttpEffect(
		frontendRoutes({
			namespaces: [implementNamespace(manifest, { frontend })],
			dev: false,
		}),
	);
	const web = HttpEffect.toWebHandler(handler);
	return (pathname: string, init?: RequestInit) =>
		Effect.promise(() =>
			web(new Request(`http://x/frontend/namespaces/ns${pathname}`, init)),
		);
});

const text = (response: Response) => Effect.promise(() => response.text());

describe("frontendRoutes", () => {
	test(
		"serves the first dir's index at the mount root",
		Effect.gen(function* () {
			const { first, second } = yield* fixtures;
			const get = yield* serve({ dir: [first, second] });
			const response = yield* get("/");
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe(
				"text/html; charset=utf-8",
			);
			expect(yield* text(response)).toBe("first index");
		}),
	);

	test(
		"serves an asset with its content type",
		Effect.gen(function* () {
			const { first } = yield* fixtures;
			const get = yield* serve({ dir: [first] });
			const response = yield* get("/app.js");
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe(
				"text/javascript; charset=utf-8",
			);
			expect(yield* text(response)).toBe("app module");
		}),
	);

	test(
		"falls through to a later dir for a file the first lacks",
		Effect.gen(function* () {
			const { first, second } = yield* fixtures;
			const get = yield* serve({ dir: [first, second] });
			const response = yield* get("/widget.js");
			expect(response.status).toBe(200);
			expect(yield* text(response)).toBe("widget module");
		}),
	);

	test(
		"the first dir wins for a file present in both",
		Effect.gen(function* () {
			const { first, second } = yield* fixtures;
			const get = yield* serve({ dir: [first, second] });
			expect(yield* text(yield* get("/shared.txt"))).toBe("from first");
		}),
	);

	test(
		"404s a missing file",
		Effect.gen(function* () {
			const { first, second } = yield* fixtures;
			const get = yield* serve({ dir: [first, second] });
			expect((yield* get("/missing.js")).status).toBe(404);
		}),
	);

	test(
		"does not resolve an extensionless path to its .html file",
		Effect.gen(function* () {
			const { first } = yield* fixtures;
			const get = yield* serve({ dir: [first] });
			expect(yield* text(yield* get("/about.html"))).toBe("about page");
			expect(
				(yield* get("/about", { headers: { accept: "text/html" } })).status,
			).toBe(404);
		}),
	);

	test(
		"404s a traversal out of the dir",
		Effect.gen(function* () {
			const { first } = yield* fixtures;
			const get = yield* serve({ dir: [first] });
			expect((yield* get("/%2e%2e/secret.txt")).status).toBe(404);
		}),
	);

	test(
		"answers a matching If-None-Match with 304",
		Effect.gen(function* () {
			const { first } = yield* fixtures;
			const get = yield* serve({ dir: [first] });
			const etag = (yield* get("/app.js")).headers.get("etag");
			expect(etag).not.toBeNull();
			const response = yield* get("/app.js", {
				headers: { "if-none-match": etag ?? "" },
			});
			expect(response.status).toBe(304);
			expect(yield* text(response)).toBe("");
		}),
	);

	describe("spa", () => {
		test(
			"falls back to the first dir with an index for a client-side route",
			Effect.gen(function* () {
				const { first, second } = yield* fixtures;
				const get = yield* serve({ dir: [second, first], spa: true });
				const response = yield* get("/some/route", {
					headers: { accept: "text/html" },
				});
				expect(response.status).toBe(200);
				expect(yield* text(response)).toBe("first index");
			}),
		);

		test(
			"an extensionless match in a later dir wins over the first dir's fallback",
			Effect.gen(function* () {
				const { first, second } = yield* fixtures;
				const get = yield* serve({ dir: [first, second], spa: true });
				expect(
					yield* text(
						yield* get("/docs", { headers: { accept: "text/html" } }),
					),
				).toBe("docs index");
			}),
		);

		test(
			"does not fall back for a missing path that has an extension",
			Effect.gen(function* () {
				const { first } = yield* fixtures;
				const get = yield* serve({ dir: [first], spa: true });
				expect((yield* get("/missing.js")).status).toBe(404);
			}),
		);

		test(
			"404s a client-side route that does not accept html",
			Effect.gen(function* () {
				const { first } = yield* fixtures;
				const get = yield* serve({ dir: [first], spa: true });
				expect((yield* get("/some/route")).status).toBe(404);
			}),
		);
	});
});
