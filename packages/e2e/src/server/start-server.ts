import {
	type LoadNodeCGOptions,
	type NamespaceShape,
	loadNodeCG,
} from "@nodecg/server";

type StartServerOptions<Shapes extends Record<string, NamespaceShape>> = Omit<
	LoadNodeCGOptions<Shapes>,
	"onReady"
>;

export const startServer = <Shapes extends Record<string, NamespaceShape>>(
	options: StartServerOptions<Shapes>,
) => {
	return loadNodeCG<Shapes>({
		...options,
		onReady: (port) => {
			if (typeof process.send === "undefined") {
				throw new Error("suite server must be spawned with an IPC channel");
			}
			process.send({ type: "ready", port });
		},
	});
};
