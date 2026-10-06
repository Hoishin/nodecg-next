# @nodecg-next/server

## 0.1.1

### Patch Changes

- Rename HumanAccount to Authentication ([`ec15619`](https://github.com/Hoishin/nodecg-next/commit/ec1561957d66f6007976380797bca4ea33df86bc))
- Dev mode is set with `NODECG_DEV=true` instead of the `dev` option of `loadNodeCG` ([`b4d2d07`](https://github.com/Hoishin/nodecg-next/commit/b4d2d0750df85aee119c677da8f18ce430aaccb5))
- Separate admin roles as global roles ([`ca0d6dd`](https://github.com/Hoishin/nodecg-next/commit/ca0d6dd68c80f3fe8e7c5f8a615aca66156843d5))
- HTTP response compression ([`b09fad3`](https://github.com/Hoishin/nodecg-next/commit/b09fad36d1467f3f0b489d959d03ec020e10e71b))
- Replicant persistence to JSON files ([`02f265e`](https://github.com/Hoishin/nodecg-next/commit/02f265e4b0ceea7a244085b7e25eb901804d0e52))
- `NODECG_` prefix on every server environment variable ([`02f265e`](https://github.com/Hoishin/nodecg-next/commit/02f265e4b0ceea7a244085b7e25eb901804d0e52))
- Session is renewed only once in NODECG_SESSION_RENEW_INTERVAL config ([`c0c8460`](https://github.com/Hoishin/nodecg-next/commit/c0c8460f1b70686ccbafeff83484191f147188f9))
- stored Replicant value is now validated on load ([`6b14d6f`](https://github.com/Hoishin/nodecg-next/commit/6b14d6f20c37dbe290f3f46462a6184cab5dfcfe))
- Carry role lists as arrays instead of sets ([`a7dd76e`](https://github.com/Hoishin/nodecg-next/commit/a7dd76e449c8e97c8af0a873a33277b5d5750adc))
- Grant and revoke a role by user ID instead of authentication ([`f4fe180`](https://github.com/Hoishin/nodecg-next/commit/f4fe180521fb2c4410291be2fae888b664280658))
- Reject role grant the namespace does not have ([`421582c`](https://github.com/Hoishin/nodecg-next/commit/421582c9455619a2a046b824d0f1e3e1c474c5b9))
- Reject bad role grants with 400 or 422 ([`f21a5dd`](https://github.com/Hoishin/nodecg-next/commit/f21a5dd869381898011dd2e9a050304120c5fa9d))
- Scope role grants to their namespace ([`94420f7`](https://github.com/Hoishin/nodecg-next/commit/94420f79dee7614f85f99f61f16b15f3863a5352))
- Roles import creates missing accounts and merges repeated entries ([`6e95fc9`](https://github.com/Hoishin/nodecg-next/commit/6e95fc90f1c73674befc9c8ea00ae975eb5853fa))
- Rename identity types to user and service account ([`8b2e5eb`](https://github.com/Hoishin/nodecg-next/commit/8b2e5eba2475b9d15c0f54288dd8a328368eec93))
- Persist logins in progress to SQLite ([`a2b9b55`](https://github.com/Hoishin/nodecg-next/commit/a2b9b55efea46f866d36742816590258b545b2c7))
- Persist roles, service accounts and API keys to SQLite ([`4df9436`](https://github.com/Hoishin/nodecg-next/commit/4df943693e0e04826f430fd7ed48ef0e63d03269))
- Persist sessions and users to SQLite ([`4ba4f28`](https://github.com/Hoishin/nodecg-next/commit/4ba4f288620a0a09f66fa1ce8508c501c23a8477))
- Serve frontend dirs with Effect's `HttpStaticServer` instead of sirv ([`a12a133`](https://github.com/Hoishin/nodecg-next/commit/a12a133b73086f23b73de9cefc32f89037175f4f))
- Accept RFC-compatible Bearer header on `/ws/v0` ([`5ef848e`](https://github.com/Hoishin/nodecg-next/commit/5ef848e41d7c13706ed4c64d2bb3c3ef043bd79c))

## 0.1.0

### Minor Changes

- Migrate to Effect 4 (`effect@4.0.0-rc.112`). Effect Schema must come from Effect 4. ([`5a414fa`](https://github.com/Hoishin/nodecg-next/commit/5a414fadf478ad4c8881c0615e437da862b40c78))
