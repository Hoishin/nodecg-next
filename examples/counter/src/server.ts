import { NodeRuntime } from "@effect/platform-node";
import { loadNodecg, loadState } from "@nodecg/server";

import { counterState } from "./state.ts";

const counter = await loadState({
	manifest: counterState,
	initialValues: { count: () => 0 },
});

NodeRuntime.runMain(loadNodecg({ states: [counter] }));
