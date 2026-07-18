import { loadNodeCG } from "@nodecg/server";

import { chain, cross, extended } from "../../src/server/namespaces.ts";
import { reportReady } from "../../src/server/report-ready.ts";

const nodecg = await loadNodeCG({
	namespaces: { chain, cross, extended },
	onReady: reportReady,
});

nodecg.start();
