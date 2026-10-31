import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
	DrizzleSqliteRepositories,
	implementNamespace,
	InMemoryTopicBroker,
	JsonFileReplicantRepository,
	loadNodeCGEffect,
	OperatingSystemService,
} from "@nodecg-next/server";
import {
	ConfigProvider,
	Effect,
	Exit,
	Layer,
	Option,
	Schema,
	Tracer,
} from "effect";
import { Reactivity } from "effect/reactivity";

import { reportReady } from "../../src/server/report-ready.ts";
import { telemetryManifest } from "./manifest.ts";

const spans: Array<Tracer.NativeSpan> = [];

const tracer = Tracer.make({
	span: (options) => {
		const span = new Tracer.NativeSpan(options);
		spans.push(span);
		return span;
	},
});

const isString = Schema.is(Schema.String);

const telemetry = implementNamespace(telemetryManifest, {
	seedReplicant: { score: () => 0 },
	implementRpc: {
		endedSpans: (name) =>
			spans.flatMap(({ name: spanName, status, parent, attributes }) => {
				if (spanName !== name || status._tag !== "Ended") {
					return [];
				}
				const path = attributes.get("url.path");
				const query = attributes.get("url.query");
				return [
					{
						root: Option.isNone(parent),
						failed: Exit.isFailure(status.exit),
						path: isString(path) ? path : null,
						query: isString(query) ? query : null,
					},
				];
			}),
	},
});

Effect.gen(function* () {
	const nodecg = yield* loadNodeCGEffect({
		namespaces: { telemetry },
		onReady: reportReady,
	});
	return yield* nodecg.start;
}).pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(
			JsonFileReplicantRepository,
			InMemoryTopicBroker,
			DrizzleSqliteRepositories,
			Layer.succeed(Tracer.Tracer, tracer),
		).pipe(
			Layer.provideMerge(
				ConfigProvider.layer(
					ConfigProvider.fromEnv().pipe(ConfigProvider.nested("NODECG")),
				),
			),
			Layer.provide(
				Layer.mergeAll(
					NodeServices.layer,
					NodeCrypto.layerSecureRandom,
					OperatingSystemService.layer,
					Reactivity.layer,
				),
			),
		),
	),
	NodeRuntime.runMain,
);
