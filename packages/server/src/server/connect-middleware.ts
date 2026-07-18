import type { IncomingMessage, ServerResponse } from "node:http";

import {
	type HttpApp,
	HttpServerError,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServerRequest } from "@effect/platform-node";
import { Effect } from "effect";

export type ConnectMiddleware = (
	req: IncomingMessage,
	res: ServerResponse,
	next: () => void | Promise<void>,
) => void;

export const connectToHttpApp = (
	middleware: ConnectMiddleware,
): HttpApp.Default<HttpServerError.RouteNotFound> =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const req = NodeHttpServerRequest.toIncomingMessage(request);
		const res = NodeHttpServerRequest.toServerResponse(request);

		req.url = request.url;

		return yield* Effect.async<
			HttpServerResponse.HttpServerResponse,
			HttpServerError.RouteNotFound
		>((resume) => {
			let settled = false;
			const finish = () => {
				if (!settled) {
					settled = true;
					resume(Effect.succeed(HttpServerResponse.empty()));
				}
			};
			res.once("finish", finish);
			res.once("close", finish);
			middleware(req, res, () => {
				if (!settled) {
					settled = true;
					resume(Effect.fail(new HttpServerError.RouteNotFound({ request })));
				}
			});
		});
	});
