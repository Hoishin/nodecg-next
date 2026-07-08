import { implementNamespace } from "@nodecg/server";

import {
	counterManifest,
	settingsManifest,
} from "../../shared/library/manifest.ts";

export const counterImplemented = implementNamespace(counterManifest, {
	seedReplicant: { count: () => 0 },
	implementRpc: {
		roll: async (max, ctx) => {
			const rolled = 1 + Math.floor(Math.random() * Math.max(1, max));
			console.log(`[counter] rpc roll(${max}) -> ${rolled}`);
			ctx.replicant.count.set(rolled);
			await ctx.topic.cheer.publish(`rolled a ${rolled}`);
			return rolled;
		},
	},
});

export const settingsImplemented = implementNamespace(settingsManifest, {
	seedReplicant: { title: () => "My Stream" },
});
