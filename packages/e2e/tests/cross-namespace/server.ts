import { cross, extended } from "../../src/server/namespaces.ts";
import { startServer } from "../../src/server/start-server.ts";

const nodecg = await startServer({ namespaces: { cross, extended } });

nodecg.start();
