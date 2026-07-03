import { Context, type Effect, type Scope, type Stream } from "effect";
import type { JsonValue } from "type-fest";

export interface TopicMessage {
	readonly namespace: string;
	readonly name: string;
	readonly value: JsonValue;
}

export interface TopicBroker {
	publish: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<void>;

	subscribe: () => Effect.Effect<
		Stream.Stream<TopicMessage>,
		never,
		Scope.Scope
	>;
}

export class TopicBrokerService extends Context.Tag("TopicBroker")<
	TopicBrokerService,
	TopicBroker
>() {}
