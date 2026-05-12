# NodeCG

Expermental new version of NodeCG in active development from scratch

## API

### Philosophy

- TypeScript first and complete type safety
- Modular and extensible
- Simple and intuitive API without pitfalls
- Immutable data structures and updates

### Shared State

- State is declarative: it is define in a single place with name and schema

  ```ts
  const stateDefinition = defineState({
    counter: { schema, initialValue, persist: false },
    games: { schema, initialValue },
    // ...
  });
  ```

- State is platform agnostic: it can be loaded with dedicated server or client API

  ```ts
  // Server-side
  import { loadState } from "@nodecg/server";

  const state = await loadState(stateDefinition);
  console.log(state.counter.getValue());

  // Client-side
  import { loadState } from "@nodecg/client";

  const state = await loadState(stateDefinition);
  console.log(await state.counter.getValue());
  ```

- State is immutable: it provides read-only value, and can only be updated with function call

  ```ts
  console.log(await state.counter.getValue()); // Returns read-only value

  await state.counter.update((value) => {
    value.timestamp = Date.now();
  });
  ```

- State is reactive: it provides subscription API to listen to changes

  ```ts
  const unsubscribe = state.counter.subscribe((newValue) => {
    console.log("Counter updated:", newValue);
  });

  // later, when you want to stop listening
  unsubscribe();
  ```

- State supports transactions: multiple updates can be batched together to ensure consistency

  ```ts
  await state.transaction(() => {
    state.counter.update((value) => {
      value.timestamp = Date.now();
    });
    state.games.update((value) => {
      value.push("New Game");
    });
  });
  ```

- State supports optimistic updates: client can update state immediately and sync with server in the background

  ```ts
  // Client-side
  state.counter.updateOptimistic((value) => {
    value.timestamp = Date.now();
  });
  ```

- State supports migrations: when schema changes, state can be migrated to new schema without data loss

  ```ts
  const newStateDefinition = defineState({
    counter: { schema: newSchema, initialValue },
    games: {
      schema: newSchema,
      initialValue,
      migration: (oldValue) => {
        return oldValue.map((game) => {
          // ...
        });
      },
    },
  });
  ```

- State supports access control: permissions can be defined for each state to control who can read or update it

  ```ts
  const stateDefinition = defineState(
    {
      counter: {
        schema,
        initialValue,
        permissions: {
          read: ["judge", "producer"],
        },
      },
      games: {
        permissions: {
          update: [], // Only system can update
        },
      },
      // ...
    },
    {
      permissions: {
        read: ["viewer"]
        update: ["admin"],
      },
    },
  );
  ```

- State supports computed values: state can define computed values that are derived from other state values in server side, and limit scope of subscription to those computed values

  ```ts
  const stateDefinition = defineState(
    {
      counter: { schema, initialValue },
      games: { schema, initialValue },
      // ...
    },
    {
      computed: {
        firstGameId: {
          schema,
          compute: (state) => state.games.getValue()[0]?.id || null,
        },
      },
    },
  );

  state.firstGameId.subscribe((firstGameId) => {
    console.log("First game updated:", firstGameId);
  });
  ```

- State supports namespaces: states can be grouped into namespaces to avoid name conflicts and manage permissions more easily

  ```ts
  const commercialStateDefinition = defineState(
    {
      isRunning: { schema, initialValue },
      remainingTime: { schema, initialValue },
    },
    {
      namespace: "commercial",
      permissions: {
        read: ["producer"],
        update: ["producer"],
      },
    },
  );
  ```

- Admin dashboard (view, clear, export, import, freeze)
- boolean option for persistence
- Hooks: `beforeUpdate`, `afterUpdate`
- State in client-side is synchronized on reconnect
- Revision number
- Conflict resolution with custom logic
- Encryption at rest
- Subscription update frequency control
- State update audit log (user, timestamp, label)
- List of subscribers with user, session, connection
- Built-in stopwatch/timer logic, scheduled updates
- Soft-delete removed state definitions
- External webhook registration for state updates

- Cross instance state sharing

#### State Schema

Supports JSON Schema, Zod, Effect Schema, Valibot

#### What happens when multiple updates happen at the same time?

#### What happens when only client defines state?

### Messaging

Status: In Planning

- Messages go through a Channel. Channels are defined with name and schema.
  ```ts
  const chatChannel = defineChannel("chat", schema);
  ```
- Messages can be sent to a channel.
  ```ts
  await chatChannel.send({ text: "Hello, world!" });
  ```
- Messages can be listened to with a callback.
  ```ts
  const unsubscribe = chatChannel.subscribe((message) => {
    console.log("Received message:", message);
  });
  ```

### Data Persistence

- Data persistence is abstracted and can be implemented for any storage backend
- Default data persistence is SQLite for system data, and JSON files for State

### Authentication

### Authorization

### Asset storage

### Outdated Client Detection

## Development

- Type check: pnpm type-check
- Start dev server: pnpm dev

## License

MIT License
