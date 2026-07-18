import { devProvider } from "../../src/server/fake-auth-provider.ts";
import { fixture } from "../../src/server/namespaces.ts";
import { startServer } from "../../src/server/start-server.ts";

const nodecg = await startServer({
	namespaces: { fixture },
	authProviders: [devProvider],
});

nodecg.start();
