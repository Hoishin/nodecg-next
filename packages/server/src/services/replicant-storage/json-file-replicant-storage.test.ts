import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { testLayer } from "@nodecg-next/test-utils";
import {
	ConfigProvider,
	Context,
	Effect,
	FileSystem,
	Layer,
	Path,
	Schema,
} from "effect";
import { TestConsole } from "effect/testing";
import { assert, describe, expect } from "vitest";

import { config } from "../../server-config.ts";
import { JsonFileReplicantStorage } from "./json-file-replicant-storage.ts";
import {
	BackendError,
	DecodeError,
	ReplicantNotFound,
	ReplicantStorageService,
} from "./replicant-storage.ts";

const temporaryDataDir = ConfigProvider.layer(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = yield* fs.makeTempDirectoryScoped();
		return ConfigProvider.fromEnvRecord({ DATA_DIR: dir });
	}),
);

const test = testLayer(
	JsonFileReplicantStorage.pipe(
		Layer.provideMerge(temporaryDataDir),
		Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
	),
);

describe("build", () => {
	const build = Effect.fn(function* (
		dataDir: string,
		workingDirectory: string,
	) {
		const path = yield* Path.Path;
		return yield* Layer.build(
			Layer.fresh(JsonFileReplicantStorage).pipe(
				Layer.provide(
					ConfigProvider.layer(
						ConfigProvider.fromEnvRecord({ DATA_DIR: dataDir }),
					),
				),
			),
		).pipe(
			Effect.provideService(Path.Path, {
				...path,
				resolve: (...segments) => path.resolve(workingDirectory, ...segments),
			}),
		);
	});

	test(
		"resolves a relative data directory against the nearest project above the working directory",
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const project = yield* fs.makeTempDirectoryScoped();
			yield* fs.writeFileString(path.join(project, "package.json"), "{}");
			const server = path.join(project, "src", "server");
			yield* fs.makeDirectory(server, { recursive: true });

			yield* build("data", server);

			expect(yield* TestConsole.logLines).toContain(
				`Storing replicants in ${path.join(project, "data", "replicants")}`,
			);
		}),
	);

	test(
		"resolves a relative data directory against the working directory outside any project",
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const outside = yield* fs.makeTempDirectoryScoped();

			yield* build("data", outside).pipe(
				Effect.provideService(FileSystem.FileSystem, {
					...fs,
					exists: () => Effect.succeed(false),
				}),
			);

			expect(yield* TestConsole.logLines).toContain(
				`Storing replicants in ${path.join(outside, "data", "replicants")}`,
			);
		}),
	);
});

describe("read", () => {
	test(
		"fails with ReplicantNotFound on a missing key",
		Effect.gen(function* () {
			const storage = yield* ReplicantStorageService;
			const error = yield* storage.read("ns", "missing").pipe(Effect.flip);
			assert(Schema.is(ReplicantNotFound)(error));
			expect(error).toMatchObject({ namespace: "ns", name: "missing" });
		}),
	);

	test(
		"fails with a decode error on a file that is not JSON",
		Effect.gen(function* () {
			const storage = yield* ReplicantStorageService;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const dir = yield* config.dataDir;
			yield* storage.write("ns", "a", 1);
			yield* fs.writeFileString(
				path.join(dir, "replicants", "ns", "a.json"),
				"{not json",
			);

			const error = yield* storage.read("ns", "a").pipe(Effect.flip);
			assert(Schema.is(DecodeError)(error));
			expect(error).toMatchObject({ issue: "Expected a valid JSON string" });
		}),
	);
});

describe("write", () => {
	test(
		"fails with a backend error when the file cannot be written",
		Effect.gen(function* () {
			const storage = yield* ReplicantStorageService;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const dir = yield* config.dataDir;
			yield* fs.makeDirectory(path.join(dir, "replicants"), {
				recursive: true,
			});
			yield* fs.writeFileString(path.join(dir, "replicants", "ns"), "");

			const error = yield* storage.write("ns", "a", 1).pipe(Effect.flip);
			assert(Schema.is(BackendError)(error));
		}),
	);

	test(
		"stores new values that read returns",
		Effect.gen(function* () {
			const storage = yield* ReplicantStorageService;
			yield* storage.write("ns", "a", 1);
			yield* storage.write("ns", "b", { list: ["two"] });
			expect(yield* storage.read("ns", "a")).toBe(1);
			expect(yield* storage.read("ns", "b")).toEqual({ list: ["two"] });
		}),
	);

	test(
		"overwrites an existing value",
		Effect.gen(function* () {
			const storage = yield* ReplicantStorageService;
			yield* storage.write("ns", "a", 1);
			yield* storage.write("ns", "a", 2);
			expect(yield* storage.read("ns", "a")).toBe(2);
		}),
	);

	test(
		"keeps one file per replicant with no temporary file left behind",
		Effect.gen(function* () {
			const storage = yield* ReplicantStorageService;
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const dir = yield* config.dataDir;
			yield* storage.write("ns", "a", 1);
			yield* storage.write("ns", "a", 2);

			expect(
				yield* fs.readDirectory(path.join(dir, "replicants", "ns")),
			).toEqual(["a.json"]);
			expect(
				yield* fs.readFileString(path.join(dir, "replicants", "ns", "a.json")),
			).toBe("2");
		}),
	);

	test(
		"a value written by one instance is read by a fresh one",
		Effect.gen(function* () {
			const storage = yield* ReplicantStorageService;
			yield* storage.write("ns", "a", { count: 3 });

			const restarted = yield* Layer.build(
				Layer.fresh(JsonFileReplicantStorage),
			);
			expect(
				yield* Context.get(restarted, ReplicantStorageService).read("ns", "a"),
			).toEqual({ count: 3 });
		}),
	);
});
