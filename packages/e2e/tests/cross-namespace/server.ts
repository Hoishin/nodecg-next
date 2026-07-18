import { loadNodeCG } from "@nodecg/server";

import { cross, extended } from "../../src/server/namespaces.ts";

const nodecg = await loadNodeCG({ namespaces: { cross, extended } });

nodecg.start();
