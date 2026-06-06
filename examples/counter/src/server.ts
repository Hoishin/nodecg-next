import { loadNamespace, loadNodecg } from "@nodecg/server";

import { counterManifest } from "./state.ts";

const counter = await loadNamespace(counterManifest, {
	seedState: { count: () => 0 },
});

loadNodecg({ namespaces: [counter] });
