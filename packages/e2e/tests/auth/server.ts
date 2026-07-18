import { loadNodeCG } from "@nodecg/server";

import { devProvider } from "../../src/server/fake-auth-provider.ts";
import { fixture } from "../../src/server/namespaces.ts";

const nodecg = await loadNodeCG({
	namespaces: { fixture },
	authProviders: [devProvider],
});

nodecg.start();
