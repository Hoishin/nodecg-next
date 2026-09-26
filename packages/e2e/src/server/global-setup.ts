import { type ChildProcess, fork } from "node:child_process";

import { NodeServices } from "@effect/platform-node";
import {
	Duration,
	Effect,
	FileSystem,
	Layer,
	ManagedRuntime,
	Path,
	Schema,
} from "effect";
import type { TestProject } from "vitest/node";

const BackendSchema = Schema.Struct({
	name: Schema.String,
	serverEntry: Schema.String,
	port: Schema.Int,
	superadmins: Schema.String,
	baseUrl: Schema.String,
});
export type Backend = typeof BackendSchema.Type;

const decodeBackends = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Array(BackendSchema)),
);

const exited = (child: ChildProcess) =>
	child.exitCode !== null || child.signalCode !== null;

const onceExit = (child: ChildProcess): Effect.Effect<void> =>
	Effect.callback((resume) => {
		if (exited(child)) {
			resume(Effect.void);
			return;
		}
		const handler = () => resume(Effect.void);
		child.once("exit", handler);
		return Effect.sync(() => child.removeListener("exit", handler));
	});

class SuiteServerExited extends Schema.TaggedError<SuiteServerExited>()(
	"SuiteServerExited",
	{ name: Schema.String, code: Schema.NullOr(Schema.Int) },
) {
	override readonly message = `suite server ${this.name} exited before ready (${this.code})`;
}

const forkServer = (
	backend: Backend,
	dataDir: string,
): Effect.Effect<ChildProcess, SuiteServerExited> =>
	Effect.callback((resume) => {
		const child = fork(backend.serverEntry, {
			env: {
				NODECG_PORT: String(backend.port),
				NODECG_BASE_URL: backend.baseUrl,
				NODECG_DATA_DIR: dataDir,
				NODECG_SUPERADMINS: backend.superadmins,
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
					Effect.fail(new SuiteServerExited({ name: backend.name, code })),
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
			Effect.timeoutOrElse({
				duration: Duration.seconds(2),
				orElse: () =>
					Effect.gen(function* () {
						child.kill("SIGKILL");
						yield* onceExit(child);
					}),
			}),
		);
	});

export default async function setup(project: TestProject) {
	const backends = decodeBackends(project.config.env["E2E_BACKENDS"]);
	const runtime = Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const dataRoot = yield* fs.makeTempDirectoryScoped({
			prefix: "nodecg-e2e-",
		});
		yield* Effect.forEach(
			backends,
			(backend) =>
				Effect.acquireRelease(
					forkServer(backend, path.join(dataRoot, backend.name)),
					stopChild,
				),
			{ concurrency: "unbounded", discard: true },
		);
	}).pipe(
		Layer.effectDiscard,
		Layer.provide(NodeServices.layer),
		ManagedRuntime.make,
	);
	await runtime.context();
	return () => runtime.dispose();
}
