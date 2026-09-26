import { Effect, FileSystem, Layer, Path, Schema, SchemaIssue } from "effect";

import { config } from "../../server-config.ts";
import {
	BackendError,
	DecodeError,
	ReplicantNotFound,
	ReplicantStorageService,
} from "./replicant-storage.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const formatIssue = SchemaIssue.makeFormatterDefault();

export const JsonFileReplicantStorage = Layer.effect(
	ReplicantStorageService,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = path.join(path.resolve(yield* config.dataDir), "replicants");
		yield* Effect.logInfo(`Storing replicants in ${root}`);

		const directory = (namespace: string) => path.join(root, namespace);
		const file = (namespace: string, name: string) =>
			path.join(directory(namespace), `${name}.json`);

		const read = Effect.fn("ReplicantStorage.read")(
			function* (namespace: string, name: string) {
				const text = yield* fs
					.readFileString(file(namespace, name))
					.pipe(
						Effect.catchReason("PlatformError", "NotFound", () =>
							ReplicantNotFound.make({ namespace, name }),
						),
					);
				return yield* decodeJson(text);
			},
			Effect.catchTags({
				PlatformError: (cause) => BackendError.make({ cause }),
				SchemaError: (error) =>
					DecodeError.make({ issue: formatIssue(error.issue) }),
			}),
		);

		const write = Effect.fn("ReplicantStorage.write")(
			function* (namespace: string, name: string, value: Schema.Json) {
				const target = file(namespace, name);
				const temporary = `${target}.tmp`;
				const bytes = new TextEncoder().encode(yield* encodeJson(value));
				const writeTemporary = fs.open(temporary, { flag: "w" }).pipe(
					Effect.tap((handle) => handle.writeAll(bytes)),
					Effect.tap((handle) => handle.sync),
					Effect.scoped,
				);
				yield* writeTemporary.pipe(
					Effect.catchReason("PlatformError", "NotFound", () =>
						fs
							.makeDirectory(directory(namespace), { recursive: true })
							.pipe(Effect.andThen(writeTemporary)),
					),
				);
				yield* fs.rename(temporary, target);
			},
			Effect.catchTag(["PlatformError", "SchemaError"], (cause) =>
				BackendError.make({ cause }),
			),
		);

		return { read, write };
	}),
);
