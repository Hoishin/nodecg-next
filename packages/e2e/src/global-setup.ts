import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export default async function setup() {
	const child = fork(
		fileURLToPath(new URL("./start-server.ts", import.meta.url)),
		{ stdio: ["ignore", "inherit", "inherit", "ipc"] },
	);

	await new Promise<void>((resolve, reject) => {
		child.once("message", (message) => {
			if (message === "ready") {
				resolve();
			}
		});
		child.once("exit", (code) =>
			reject(new Error(`server exited before ready (code ${code})`)),
		);
	});

	return function teardown() {
		child.kill();
	};
}
