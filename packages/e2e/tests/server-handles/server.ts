import { fixture } from "../../src/server/namespaces.ts";
import { loadNodeCG } from "@nodecg/server";

const nodecg = await loadNodeCG({ namespaces: { fixture } });

const { mirrorSource, mirror } = nodecg.namespaces.fixture.replicant;
await mirrorSource.subscribe((value) => {
	mirror.set(value);
});

nodecg.start();
