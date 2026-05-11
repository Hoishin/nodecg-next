import { createServer } from "node:http";

import {
	HttpRouter,
	HttpServer,
	HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Layer } from "effect";

const router = HttpRouter.empty.pipe(
	HttpRouter.get("/", HttpServerResponse.text("OK")),
);

HttpServer.serve(router).pipe(
	Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3000 })),
	Layer.launch,
	NodeRuntime.runMain,
);
