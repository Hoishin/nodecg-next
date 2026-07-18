import { loadNodeCG } from "@nodecg/server";

import { fixture } from "../../src/server/namespaces.ts";
import { reportReady } from "../../src/server/report-ready.ts";

const nodecg = await loadNodeCG({
	namespaces: { fixture },
	onReady: reportReady,
});

const { mirrorSource, mirror } = nodecg.namespaces.fixture.replicant;
await mirrorSource.subscribe((value) => {
	mirror.set(value);
});

nodecg.start();
