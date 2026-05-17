import { NodeRuntime } from "@effect/platform-node";
import { loadNodecg } from "@nodecg/server";

NodeRuntime.runMain(loadNodecg({ states: [] }));
