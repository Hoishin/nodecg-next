import { Effect, Layer, PubSub, Stream } from "effect";
import type { JsonValue } from "type-fest";

import { type TopicMessage, TopicBrokerService } from "./topic-broker.ts";

export const InMemoryTopicBroker = Layer.effect(
	TopicBrokerService,
	Effect.gen(function* () {
		const messages = yield* PubSub.unbounded<TopicMessage>();

		return {
			publish: (namespace: string, name: string, value: JsonValue) =>
				PubSub.publish(messages, { namespace, name, value }).pipe(
					Effect.asVoid,
				),
			subscribe: () =>
				PubSub.subscribe(messages).pipe(Effect.map(Stream.fromSubscription)),
		};
	}),
);
