import { implementNamespace, loadNodeCG } from "@nodecg-next/server";

import { devProvider } from "../../src/server/fake-auth-provider.ts";
import { reportReady } from "../../src/server/report-ready.ts";
import { nestAssetsManifest, nestManifest } from "./manifest.ts";

const nest = implementNamespace(nestManifest, {
	children: {
		assets: implementNamespace(nestAssetsManifest, {
			seedReplicant: { files: () => 4, uploads: () => 0 },
		}),
	},
});

const nodecg = await loadNodeCG({
	namespaces: { nest },
	authProviders: [devProvider],
	onReady: reportReady,
});

nodecg.start();
