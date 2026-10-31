import { implementNamespace, loadNodeCG } from "@nodecg-next/server";
import { tickerNamespace } from "@nodecg/example-plugin-ticker/server";
import { timeNamespace } from "@nodecg/example-plugin-time/server";

import { showManifest } from "../shared/manifest.ts";

const showNamespace = implementNamespace(showManifest, {
	seedReplicant: { title: () => "Nested namespaces" },
	children: { ticker: tickerNamespace, time: timeNamespace },
	implementComputed: {
		visibleMessages: (ctx) => {
			const now = ctx.use(timeNamespace).replicant.time.get();
			return ctx
				.use(tickerNamespace)
				.replicant.messages.get()
				.filter(({ postedAt }) => now - postedAt < 10_000)
				.map(({ text }) => text);
		},
	},
	frontend: {
		dir: [import.meta.resolve("../../dist")],
		vite: { root: import.meta.resolve("../..") },
	},
});

const nodecg = await loadNodeCG({
	namespaces: { show: showNamespace },
});

nodecg.start();
