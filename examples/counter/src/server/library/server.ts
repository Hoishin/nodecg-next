import { implementNamespace } from "@nodecg/server";

import {
	counterManifest,
	settingsManifest,
} from "../../shared/library/manifest.ts";

// TODO: use callback args for replicant updates
let setCount: ((value: number) => void) | undefined;
export const bindCounterReplicant = (set: (value: number) => void) => {
	setCount = set;
};

export const counterImplemented = implementNamespace(counterManifest, {
	seedReplicant: { count: () => 0 },
	implementRpc: {
		roll: (max) => {
			const rolled = 1 + Math.floor(Math.random() * Math.max(1, max));
			console.log(`[counter] rpc roll(${max}) -> ${rolled}`);
			setCount?.(rolled);
			return rolled;
		},
	},
});

export const settingsImplemented = implementNamespace(settingsManifest, {
	seedReplicant: { title: () => "My Stream" },
});
