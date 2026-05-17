import { NodeRuntime } from "@effect/platform-node";
import { InMemoryStateStorage } from "@nodecg/server/in-memory-state-storage";
import { loadNodeCG } from "@nodecg/server/load-nodecg";

loadNodeCG({ states: [], storage: InMemoryStateStorage }).pipe(
	NodeRuntime.runMain,
);
