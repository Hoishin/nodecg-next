import type { ClientMessage, ServerMessage } from "@nodecg/internal";
import {
	Context,
	Data,
	type Effect,
	type ParseResult,
	type Stream,
} from "effect";

export class MessageEncodeError extends Data.TaggedError("MessageEncodeError")<{
	cause: ParseResult.ParseError;
}> {
	override readonly message = `Could not encode message: ${this.cause.message}`;
}

export class MessageChannelFailError extends Data.TaggedError(
	"MessageChannelFailError",
)<{
	cause: Error;
}> {
	override readonly message = `Message channel failed: ${this.cause.message}`;
}

export interface MessageChannel {
	send: (message: ClientMessage) => Effect.Effect<void, MessageEncodeError>;
	messages: Stream.Stream<ServerMessage, MessageChannelFailError>;
}

export class MessageChannelService extends Context.Tag("MessageChannel")<
	MessageChannelService,
	MessageChannel
>() {}
