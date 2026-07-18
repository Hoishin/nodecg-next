import { loadNodeCG } from "@nodecg/server";

import { cross, extended } from "../../src/server/namespaces.ts";
import { reportReady } from "../../src/server/report-ready.ts";

const nodecg = await loadNodeCG({
	namespaces: { cross, extended },
	onReady: reportReady,
});

nodecg.start();
