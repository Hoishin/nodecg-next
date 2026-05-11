# NodeCG

Expermental new version of NodeCG in active development from scratch

## API

### Philosophy

- TypeScript first and complete type safety
- Modular and extensible
- Simple and intuitive API without pitfalls
- Immutable data structures and updates

### Shared State

Status: In Planning

- State is declarative: it is defined with name and schema
  ```ts
  const counterState = defineState("counter", schema);
  ```
- State is immutable: it provides read-only value, and can only be updated with function call

  ```ts
  console.log(counterState.value); // recursive read-only

  await counterState.update((count) => {
    count.value += 1;
  });
  ```

- State is reactive: it provides subscription API to listen to changes

  ```ts
  const unsubscribe = counterState.subscribe((newValue) => {
    console.log("Counter updated:", newValue);
  });

  // later, when you want to stop listening
  unsubscribe();
  ```

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

Status: In Planning

- Data persistence is abstracted and can be implemented for any storage backend
- Default data persistence is SQLite for system data, and JSON files for State

### Authentication

Status: In Planning

### Authorization

Status: In Planning

## Development

- Type check: pnpm type-check
- Start dev server: pnpm dev

## License

MIT License
