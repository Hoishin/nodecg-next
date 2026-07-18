import { loadNodeCG } from "@nodecg/server";

import { devProvider } from "../../src/server/fake-auth-provider.ts";
import { extended, fixture } from "../../src/server/namespaces.ts";

const nodecg = await loadNodeCG({
	namespaces: { fixture, extended },
	authProviders: [devProvider],
});

nodecg.start();
