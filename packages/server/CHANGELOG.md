# @nodecg-next/server

## 0.2.0

### Minor Changes

- Separate admin roles as global roles ([`ca0d6dd`](https://github.com/Hoishin/nodecg-next/commit/ca0d6dd68c80f3fe8e7c5f8a615aca66156843d5))
- Scope role grants to their namespace ([`94420f7`](https://github.com/Hoishin/nodecg-next/commit/94420f79dee7614f85f99f61f16b15f3863a5352))

### Patch Changes

- HTTP response compression ([`b09fad3`](https://github.com/Hoishin/nodecg-next/commit/b09fad36d1467f3f0b489d959d03ec020e10e71b))
- Carry role lists as arrays instead of sets ([`a7dd76e`](https://github.com/Hoishin/nodecg-next/commit/a7dd76e449c8e97c8af0a873a33277b5d5750adc))
- Nest role target under `login` ([`279b7cc`](https://github.com/Hoishin/nodecg-next/commit/279b7cc11d8287319252d14760cea0a4a786fe9f))
- Reject role grant the namespace does not have ([`421582c`](https://github.com/Hoishin/nodecg-next/commit/421582c9455619a2a046b824d0f1e3e1c474c5b9))
- Serve frontend dirs with Effect's `HttpStaticServer` instead of sirv ([`a12a133`](https://github.com/Hoishin/nodecg-next/commit/a12a133b73086f23b73de9cefc32f89037175f4f))
- Accept RFC-compatible Bearer header on `/ws/v0` ([`5ef848e`](https://github.com/Hoishin/nodecg-next/commit/5ef848e41d7c13706ed4c64d2bb3c3ef043bd79c))

## 0.1.0

### Minor Changes

- Migrate to Effect 4 (`effect@4.0.0-rc.112`). Effect Schema must come from Effect 4. ([`5a414fa`](https://github.com/Hoishin/nodecg-next/commit/5a414fadf478ad4c8881c0615e437da862b40c78))
