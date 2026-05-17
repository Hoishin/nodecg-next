import { NodeRuntime } from "@effect/platform-node";
import { loadNodecg } from "@nodecg/server/load-nodecg";

loadNodecg({ states: [] }).pipe(NodeRuntime.runMain);
