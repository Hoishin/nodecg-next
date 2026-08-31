import { createServer, type Server } from "node:http";

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { testEffect } from "@nodecg/internal/test-utils";
import { Effect } from "effect";
import { afterAll, describe, expect, test, vi } from "vitest";

import { buildViteServer } from "./vite-dev-server.ts";

vi.stubEnv("NODECG_BASE_URL", "http://localhost:3000/sub");
afterAll(() => {
	vi.unstubAllEnvs();
});

const startDevServer = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.makeTempDirectoryScoped();
	yield* fs.writeFileString(
		`${root}/index.html`,
		"<html><head><title>t</title></head><body>dev</body></html>",
	);
	yield* fs.writeFileString(`${root}/app.js`, "console.log(1);");
	const devServer = yield* buildViteServer({
		root,
		prefix: "/frontend/namespaces/ns",
		spa: false,
	});
	const server = yield* Effect.acquireRelease(
		Effect.async<Server>((resume) => {
			const server = createServer((req, res) => {
				devServer.middlewares(req, res, () => {
					res.statusCode = 404;
					res.end();
				});
			});
			server.listen(0, () => {
				resume(Effect.succeed(server));
			});
		}),
		(server) =>
			Effect.async<void>((resume) => {
				server.close(() => {
					resume(Effect.void);
				});
			}),
	);
	const address = server.address();
	if (address === null || typeof address === "string") {
		return yield* Effect.die("expected address object");
	}
	return `http://localhost:${address.port}`;
}).pipe(Effect.provide(NodeFileSystem.layer));

const request = (origin: string, path: string) =>
	Effect.promise(async () => {
		const response = await fetch(`${origin}${path}`);
		return { status: response.status, body: await response.text() };
	});

describe("buildViteServer", () => {
	test(
		"serves the index under the configured base",
		testEffect(
			Effect.gen(function* () {
				const origin = yield* startDevServer;
				const response = yield* request(origin, "/sub/frontend/namespaces/ns/");
				expect(response.status).toBe(200);
				expect(response.body).toContain("dev");
			}),
		),
	);

	test(
		"serves an asset under the configured base",
		testEffect(
			Effect.gen(function* () {
				const origin = yield* startDevServer;
				const response = yield* request(
					origin,
					"/sub/frontend/namespaces/ns/app.js",
				);
				expect(response.status).toBe(200);
			}),
		),
	);
});
