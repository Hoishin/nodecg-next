import { Effect, Layer, PubSub, Stream } from "effect";
import type { JsonValue } from "type-fest";

import { type TopicMessage, TopicBrokerService } from "./topic-broker.ts";

export const InMemoryTopicBroker = Layer.effect(
	TopicBrokerService,
	Effect.gen(function* () {
		const messages = yield* PubSub.unbounded<TopicMessage>();

		const publish = Effect.fn("TopicBroker.publish")(function* (
			namespace: string,
			name: string,
			value: JsonValue,
		) {
			yield* messages.publish({ namespace, name, value });
		});

		return {
			publish,
			subscribe: () => Stream.fromPubSub(messages, { scoped: true }),
		};
	}),
);
