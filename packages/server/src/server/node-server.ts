import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";

export const nodeServer = () =>
	NodeHttpServer.layer(() => createServer(), { port: 3000 });
