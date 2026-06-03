import type { ClientMessage, ServerMessage } from "@nodecg/internal";
import {
	Context,
	Data,
	type Effect,
	type ParseResult,
	type Scope,
	type Stream,
} from "effect";

export class MessageEncodeError extends Data.TaggedError("MessageEncodeError")<{
	cause: ParseResult.ParseError;
}> {
	override readonly message = `Could not encode message: ${this.cause.message}`;
}

export interface MessageChannel {
	send: (message: ClientMessage) => Effect.Effect<void, MessageEncodeError>;
	receive: () => Effect.Effect<
		Stream.Stream<ServerMessage>,
		never,
		Scope.Scope
	>;
}

export class MessageChannelService extends Context.Tag("MessageChannel")<
	MessageChannelService,
	MessageChannel
>() {}
