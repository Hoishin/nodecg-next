import { devProvider } from "../../src/server/fake-auth-provider.ts";
import { extended, fixture } from "../../src/server/namespaces.ts";
import { startServer } from "../../src/server/start-server.ts";

const nodecg = await startServer({
	namespaces: { fixture, extended },
	authProviders: [devProvider],
});

nodecg.start();
