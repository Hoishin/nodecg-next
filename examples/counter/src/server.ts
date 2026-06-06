import { loadNodecg } from "@nodecg/server";

import { counter } from "./app.ts";

loadNodecg({ namespaces: [counter] });
