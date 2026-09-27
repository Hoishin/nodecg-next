import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { testLayer } from "@nodecg-next/test-utils";
import { eq } from "drizzle-orm";
import {
	ConfigProvider,
	Effect,
	FileSystem,
	Layer,
	Path,
	Schema,
} from "effect";
import { TestConsole } from "effect/testing";
import { Reactivity } from "effect/unstable/reactivity";
import { assert, describe, expect } from "vitest";

import {
	DrizzleSqliteDatabaseService,
	MigrationsNotFound,
} from "./drizzle-sqlite-database.ts";
import { loginAttempts } from "./tables.ts";

const test = testLayer(
	Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, Reactivity.layer),
);

describe("make", () => {
	test(
		"keeps what was stored in a file across reopening it",
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const file = path.join(
				yield* fs.makeTempDirectoryScoped(),
				"nodecg.sqlite3",
			);
			const row = {
				key: "k",
				provider: "dev",
				state: "s",
				codeVerifier: null,
				nonce: null,
				returnTo: null,
				expiresAt: 1000,
			};
			const first = yield* DrizzleSqliteDatabaseService.make(file);
			yield* first.insert(loginAttempts).values(row);
			const second = yield* DrizzleSqliteDatabaseService.make(file);

			expect(
				yield* second
					.select()
					.from(loginAttempts)
					.where(eq(loginAttempts.key, "k")),
			).toStrictEqual([row]);
		}),
	);

	test(
		"fails with MigrationsNotFound when no package holds the server",
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const error = yield* DrizzleSqliteDatabaseService.make(":memory:").pipe(
				Effect.provideService(FileSystem.FileSystem, {
					...fs,
					exists: () => Effect.succeed(false),
				}),
				Effect.flip,
			);

			assert(Schema.is(MigrationsNotFound)(error));
			expect(error).toMatchObject({
				from: yield* path.fromFileUrl(new URL(".", import.meta.url)),
			});
		}),
	);
});

describe("layer", () => {
	test(
		"opens nodecg.sqlite3 in the data directory, creating the directory",
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const dataDir = path.join(yield* fs.makeTempDirectoryScoped(), "data");

			yield* Layer.build(
				DrizzleSqliteDatabaseService.layer.pipe(
					Layer.provide(
						ConfigProvider.layer(
							ConfigProvider.fromEnvRecord({ DATA_DIR: dataDir }),
						),
					),
				),
			);

			expect(yield* fs.exists(path.join(dataDir, "nodecg.sqlite3"))).toBe(true);
			expect(yield* TestConsole.logLines).toContain(
				`Storing system data in ${path.join(dataDir, "nodecg.sqlite3")}`,
			);
		}),
	);
});
