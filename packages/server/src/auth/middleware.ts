import { AuthenticationMiddleware } from "@nodecg/internal";
import { Effect, Layer } from "effect";

export const AuthenticationMiddlewareLive = Layer.succeed(
	AuthenticationMiddleware,
	Effect.succeed({ _tag: "public" }),
);
