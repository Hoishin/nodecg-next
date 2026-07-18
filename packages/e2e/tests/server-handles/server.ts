import { fixture } from "../../src/server/namespaces.ts";
import { startServer } from "../../src/server/start-server.ts";

const nodecg = await startServer({ namespaces: { fixture } });

const { mirrorSource, mirror } = nodecg.namespaces.fixture.replicant;
await mirrorSource.subscribe((value) => {
	mirror.set(value);
});

nodecg.start();
