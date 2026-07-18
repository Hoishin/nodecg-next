import { fork } from "node:child_process";

import type { TestProject } from "vitest/node";

export interface ForkedServer {
	readonly teardown: () => void;
}

export const forkServer = (
	entryPath: string,
	env: Record<string, string | undefined> = {},
): Promise<ForkedServer> =>
	new Promise((resolve, reject) => {
		const child = fork(entryPath, {
			env,
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		child.once("message", (message: { type?: string; port?: number }) => {
			if (message.type === "ready") {
				resolve({
					teardown: () => child.kill(),
				});
			}
		});
		child.once("exit", (code) =>
			reject(new Error(`suite server exited before ready (code ${code})`)),
		);
	});

export default async function setup(project: TestProject) {
	const port = project.config.env["PORT"];
	if (typeof port !== "string") {
		throw new Error("Missing PORT in project config env");
	}
	const serverEntry = project.config.env["SERVER_ENTRY"];
	if (typeof serverEntry !== "string") {
		throw new Error("Missing SERVER_ENTRY in project config env");
	}
	const { teardown } = await forkServer(serverEntry, {
		PORT: port,
		SUPERADMINS: project.config.env["SUPERADMINS"],
	});
	return teardown;
}
