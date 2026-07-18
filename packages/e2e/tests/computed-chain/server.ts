import { loadNodeCG } from "@nodecg/server";

import { chain, cross, extended } from "../../src/server/namespaces.ts";

const nodecg = await loadNodeCG({ namespaces: { chain, cross, extended } });

nodecg.start();
