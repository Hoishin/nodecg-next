import { implementNamespace, loadNodeCG } from "@nodecg-next/server";

import { reportReady } from "../../src/server/report-ready.ts";
import { nestAssetsManifest, nestManifest } from "./manifest.ts";

const nest = implementNamespace(nestManifest, {
	children: {
		assets: implementNamespace(nestAssetsManifest, {
			seedReplicant: { files: () => 4 },
		}),
	},
});

const nodecg = await loadNodeCG({
	namespaces: { nest },
	onReady: reportReady,
});

nodecg.start();
