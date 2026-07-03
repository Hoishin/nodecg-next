# NodeCG

Experimental new version of NodeCG in active development from scratch

## API

### Philosophy

- Modular and extensible
- Decoupled client-side that supports both browsers and servers
- Simple and intuitive APIs without pitfalls
- Immutable data structures and updates
- TypeScript first and complete type safety

### Draft

```ts
const roles = defineRoles({
  judge: {
    description: "Judge standing next to the players",
    permission: ["all"], // Or "state-read" | "state-write" | "computed-read" | "topic-subscribe" | "topic-publish"
  },
  monitor: {
    permission: ["state-read", "computed-read", "topic-subscribe"],
  },
  viewer: {
    permission: ["state-read", "computed-read"],
  },

  // Reserved role for all users by default
  everyone: {
    permission: ["state-read", "computed-read"],
  },
}); // Automatically adds "everyone" which means all users, no permissions

const match = defineNamespace("match", {
  state: {
    score: {
      schema: Schema.Struct({ left: Schema.Number, right: Schema.Number }),
      permission: {
        read: {
          deny: [roles.viewer],
        },
      },
    },
    label: {
      schema: Schema.NonEmptyTrimmedString,
      permission: {
        write: {
          allow: [roles.monitor],
        },
      },
    },
  },

  computed: {
    winning: {
      schema: Schema.OptionFromNullOr(Schema.Literal("left", "right")),
      permission: {
        read: {
          deny: [roles.judge],
        },
      },
    },
  },

  // Not yet
  data: {
    upcoming: {
      schema: Schema.Array(Schema.Struct({ id: Schema.UUID /* ... */ })),
    },
  },
  topic: {
    start: {
      schema: Schema.Boolean,
      permission: {
        subscribe: {
          deny: [roles.viewer],
        },
      },
    },
  },
});

// Server-side
const match = loadNamespace(match, {
  seedState: {
    score: () => ({ left: 0, right: 0 }),
    label: () => "Match 1",
  },
  implementComputed: {
    winning: (state) => {
      const leftAdvantage = state.score.left - state.score.right;
      return leftAdvantage > 0 ? "left" : leftAdvantage < 0 ? "right" : null;
    },
  },
});

match.state.label.get() === "Match 123";

// Client-side
const match = loadNamespace(match);

match.state.label.subscribe((label) => {
  dom.innerText = label;
});
```

### Shared State

- ✅ State is declarative: defined in one place with name and schema

  ```ts
  const manifest = defineNamespace("match", {
    state: { counter: { schema }, games: { schema } },
  });
  ```

- ✅ State is platform agnostic: loaded with a dedicated server or client API

  ```ts
  // Server-side
  import { loadNamespace } from "@nodecg/server";

  const ns = await loadNamespace(manifest, {
    seedState: { counter: () => 0, games: () => [] },
  });
  console.log(ns.state.counter.get()); // synchronous on the server

  // Client-side
  import { loadNamespace } from "@nodecg/client";

  const ns = await loadNamespace(manifest);
  console.log(await ns.state.counter.get()); // asynchronous over the network
  ```

- ✅ State is immutable: read-only value, set or updated by returning a new value from the updater (which may be async)

  ```ts
  console.log(await ns.state.counter.get()); // Returns read-only value

  await ns.state.counter.set({ count: n, timestamp: Date.now() });

  await ns.state.counter.update((value) => ({
    ...value,
    timestamp: Date.now(),
  }));
  ```

- ✅ State is reactive: subscribe to listen to changes

  ```ts
  const unsubscribe = await ns.state.counter.subscribe((newValue) => {
    console.log("Counter updated:", newValue);
  });

  // later, when you want to stop listening
  unsubscribe();
  ```

- 🚧 State supports transactions: batch multiple updates for consistency

  ```ts
  await ns.transaction(() => {
    ns.state.counter.update((value) => ({ ...value, timestamp: Date.now() }));
    ns.state.games.update((value) => [...value, "New Game"]);
  });
  ```

- 🚧 State supports migrations: when a schema changes, migrate without data loss

  ```ts
  const newManifest = defineNamespace("match", {
    state: {
      counter: { schema },
      games: {
        schema,
        migration: [
          {
            oldSchema,
            migrate: (oldValue) => oldValue.map((game) => /* ... */ game),
          },
        ],
      },
    },
  });
  ```

- 🚧 State supports access control: roles declare default capabilities; per-field `allow`/`deny` refine them

  ```ts
  const manifest = defineNamespace("match", {
    roles: {
      judge: { permission: ["state-read", "state-write"] },
      viewer: { permission: ["state-read"] },
    },
    state: {
      counter: { schema, permission: { read: { deny: ["viewer"] } } },
      games: { schema, permission: { write: { allow: ["server"] } } }, // server-owned
    },
  });
  ```

- ✅ State supports computed values derived from other state: the manifest declares the schema, the compute function is provided on the server at load

  ```ts
  // Manifest: declare schema only
  const manifest = defineNamespace("match", {
    state: { counter: { schema }, games: { schema } },
    computed: { firstGameId: { schema } },
  });

  // Server: provide the compute function
  const ns = await loadNamespace(manifest, {
    seedState: { counter: () => 0, games: () => [] },
    implementComputed: {
      firstGameId: (sources) => sources.games[0]?.id ?? null,
    },
  });

  // Client: read-only
  const ns = await loadNamespace(manifest);
  await ns.computed.firstGameId.subscribe((firstGameId) => {
    console.log("First game updated:", firstGameId);
  });
  ```

- ✅ State is grouped into namespaces to avoid name conflicts and scope permissions

  ```ts
  const commercialManifest = defineNamespace("commercial", {
    roles: { producer: { permission: ["state-read", "state-write"] } },
    state: {
      isRunning: { schema, permission: { write: { allow: ["producer"] } } },
      remainingTime: { schema },
    },
  });
  ```

- ✅ Namespaces can be extended: add fields and roles or override permissions

  ```ts
  // Library
  const base = implementNamespace(baseManifest, {
    seedState: { score: () => 0 },
  });

  // Application
  const extendedManifest = extendNamespace(baseManifest, {
    state: { round: { schema } },
    computed: { total: { schema } }, // may read original + newly-added state
  });

  const loaded = await loadExtendedNamespace(extendedManifest, base, {
    seedState: { round: () => 0 },
    implementComputed: { total: (sources) => sources.score + sources.round },
  });
  ```

- 🚧 Admin dashboard (view, clear, export, import, freeze)
- 🚧 boolean option for persistence
- 🚧 Hooks: `beforeUpdate`, `afterUpdate`
- 🚧 State in client-side is synchronized on reconnect
- 🚧 Revision number
- 🚧 Conflict resolution with custom logic
- 🚧 Encryption at rest
- 🚧 Subscription update frequency control
- 🚧 State update audit log (user, timestamp, label)
- 🚧 List of subscribers with user, session, connection
- 🚧 Built-in stopwatch/timer logic, scheduled updates
- 🚧 Soft-delete removed state definitions
- 🚧 External webhook registration for state updates

- 🚧 Cross instance state sharing

#### State Schema

- ✅ Effect Schema
- 🚧 JSON Schema
- 🚧 Zod
- 🚧 Valibot

#### What happens when multiple updates happen at the same time?

#### What happens when only client defines state?

### Messaging

- ✅ Topics fan out message with no reply

  ```ts
  const manifest = defineNamespace("chat", {
    topic: {
      message: {
        schema: Schema.String,
        permission: {
          read: { allow: ["public"] },
          write: { allow: ["public"] },
        },
      },
    },
  });

  const ns = await loadNamespace(manifest);
  await ns.topic.message.publish("Hello, world!");
  const cancel = await ns.topic.message.subscribe((message) => {
    console.log("Received:", message);
  });
  ```

- ✅ RPC is a 1:1 addressed call with a reply

  ```ts
  const manifest = defineNamespace("dice", {
    rpc: {
      roll: {
        schema: { request: Schema.Number, response: Schema.Number },
        permission: { write: { allow: ["public"] } },
      },
    },
  });

  // Server: provide the handler
  const ns = await loadNamespace(manifest, {
    implementRpc: { roll: (max) => 1 + Math.floor(Math.random() * max) },
  });

  // Client: call and await the reply
  const rolled = await ns.rpc.roll.call(6);
  ```

- 🚧 Per-RPC typed error schema (`{ request, response, error }`)

### 🚧 Data

For datasets too large to keep in memory. Unlike State, which is mirrored in memory and read synchronously, Data is read and written asynchronously, straight from the store, and never kept in-memory permanently.

### Data Persistence

- ✅ Data persistence is abstracted and can be implemented for any storage backend
- 🚧 Default data persistence is SQLite for system data, and JSON files for State

### 🚧 Authentication

### 🚧 Authorization

### ✅ Frontend serving

- Each namespace serves its own frontend files from the same origin under `/frontend/namespaces/{ns}/`
  - built static directory in production
  - optionally Vite dev server (HMR) for development

### 🚧 Asset storage

- Operator-managed media (images/videos/audio): upload/list/delete with a reactive metadata index that graphics subscribe to

### 🚧 Outdated Client Detection

## Development

- Install: `pnpm install`
- Type check: `pnpm type-check`
- Test: `pnpm test`
- Lint: `pnpm lint`
- Format: `pnpm fmt`
- Start dev server: `pnpm dev`

### Architecture

NodeCG is a full-stack framework where there are server-side code, client-side code, and small runtime code and types used in both environment. In order to have clear separation, this repository uses monorepo with pnpm.

- Server-side package: vitest runs on Node.js environment. Can use APIs from `node:*` imports. Cannot use browser APIs (window, document, etc)
- Client-side package: vitest runs browser mode and runs tests in real browsers. Can use browser APIs, but cannot use `node:*` imports.
- Package for both: vitest runs both on Node.js environment and browser mode. Cannot import `node:*` and cannot use browser APIs.

The codebase uses Effect for type-safety, error-safety, and dependency injection.

- Entire codebase runs as Effect, except user-facing functions that provides both Effect-based interface and non-Effect interface. The boundary is at the very edge to keep the advantages of Effect.

## License

MIT License
