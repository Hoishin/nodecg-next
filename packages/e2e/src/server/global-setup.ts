import { type ChildProcess, fork } from "node:child_process";

import { Duration, Effect, Schema } from "effect";
import type { TestProject } from "vitest/node";

const BackendSchema = Schema.Struct({
	name: Schema.String,
	serverEntry: Schema.String,
	port: Schema.Number,
	superadmins: Schema.String,
	baseUrl: Schema.String,
});
export type Backend = typeof BackendSchema.Type;

const decodeBackends = Schema.decodeUnknownSync(
	Schema.parseJson(Schema.Array(BackendSchema)),
);

const exited = (child: ChildProcess) =>
	child.exitCode !== null || child.signalCode !== null;

const onceExit = (child: ChildProcess): Effect.Effect<void> =>
	Effect.async((resume) => {
		if (exited(child)) {
			resume(Effect.void);
			return;
		}
		const handler = () => resume(Effect.void);
		child.once("exit", handler);
		return Effect.sync(() => child.removeListener("exit", handler));
	});

const forkServer = (backend: Backend): Effect.Effect<ChildProcess, Error> =>
	Effect.async((resume) => {
		const child = fork(backend.serverEntry, {
			env: {
				PORT: String(backend.port),
				NODECG_BASE_URL: backend.baseUrl,
				SUPERADMINS: backend.superadmins,
			},
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		let settled = false;
		child.once("message", (message: { type?: string }) => {
			if (message.type === "ready" && !settled) {
				settled = true;
				resume(Effect.succeed(child));
			}
		});
		child.once("exit", (code) => {
			if (!settled) {
				settled = true;
				resume(
					Effect.fail(
						new Error(
							`suite server ${backend.name} exited before ready (${code})`,
						),
					),
				);
			}
		});
	});

const stopChild = (child: ChildProcess): Effect.Effect<void> =>
	Effect.gen(function* () {
		if (exited(child)) {
			return;
		}
		child.kill();
		yield* onceExit(child).pipe(
			Effect.timeoutTo({
				duration: Duration.seconds(2),
				onSuccess: () => Effect.void,
				onTimeout: () =>
					Effect.gen(function* () {
						child.kill("SIGKILL");
						yield* onceExit(child);
					}),
			}),
			Effect.flatten,
		);
	});

export default async function setup(project: TestProject) {
	const backends = decodeBackends(project.config.env["E2E_BACKENDS"]);
	const children = await Effect.runPromise(
		Effect.forEach(backends, forkServer, { concurrency: "unbounded" }),
	);
	return () =>
		Effect.runPromise(
			Effect.forEach(children, stopChild, {
				concurrency: "unbounded",
				discard: true,
			}),
		);
}
