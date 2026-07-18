import { loadNodeCG } from "@nodecg/server";

import { devProvider } from "../../src/server/fake-auth-provider.ts";
import { extended, fixture } from "../../src/server/namespaces.ts";
import { reportReady } from "../../src/server/report-ready.ts";

const nodecg = await loadNodeCG({
	namespaces: { fixture, extended },
	authProviders: [devProvider],
	onReady: reportReady,
});

nodecg.start();
