import { implementNamespace } from "@nodecg/server";

import { counterManifest, settingsManifest } from "./manifest.ts";

export const counterImplemented = implementNamespace(counterManifest, {
	seedState: { count: () => 0 },
});

export const settingsImplemented = implementNamespace(settingsManifest, {
	seedState: { title: () => "My Stream" },
});
