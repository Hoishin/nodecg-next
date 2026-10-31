import {
	ConfigProvider,
	Effect,
	FileSystem,
	Layer,
	Path,
	Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { Otlp, OtlpSerialization } from "effect/observability";

import { findPackageRoot } from "./package-root.ts";

const decodePackageJson = Schema.decodeEffect(
	Schema.fromJsonString(
		Schema.Struct({
			name: Schema.optional(Schema.NonEmptyString),
			version: Schema.optional(Schema.NonEmptyString),
		}),
	),
);

const readProject = Effect.fn(
	function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = yield* findPackageRoot(path.resolve()).pipe(
			Effect.flatMap(Effect.fromOption),
		);
		const text = yield* fs.readFileString(path.join(root, "package.json"));
		return yield* decodePackageJson(text);
	},
	Effect.catchTag(["NoSuchElementError", "PlatformError", "SchemaError"], () =>
		Effect.succeed({ name: undefined, version: undefined }),
	),
);

export const OtlpTelemetry = Otlp.layerFromConfig().pipe(
	Layer.provide(OtlpSerialization.layerProtobuf),
	Layer.provide(FetchHttpClient.layer),
	Layer.provide(
		ConfigProvider.layerAdd(
			readProject().pipe(
				Effect.map(({ name, version }) =>
					ConfigProvider.fromEnvRecord({
						OTEL_SERVICE_NAME: name ?? "nodecg",
						OTEL_SERVICE_VERSION: version,
						OTEL_TRACES_EXPORTER: "otlp",
						OTEL_LOGS_EXPORTER: "otlp",
						OTEL_METRICS_EXPORTER: "otlp",
					}),
				),
			),
		),
	),
);
