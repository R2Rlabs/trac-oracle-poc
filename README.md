# trac-oracle-poc

Proof of concept: a Trac Network contract (`trac-peer` subnet app) that accepts price data only if it
carries valid Pyth signatures. It verifies them on every node, so the subnet admin is not in the price path.

## Why

On Trac, outside data normally enters a contract through a "Feature", and `trac-peer` only accepts
Feature data signed by the subnet admin (`src/operations/feature/index.js`). For a perps exchange, that
means the admin could set any price and liquidate anyone. This contract registers no Features. Anyone can
submit a Pyth update as an ordinary transaction, and every node checks it against a pinned trust anchor.

## Chain of trust

```
Pyth signer set (pinned in src/trust-anchor.js)
  └─ quorum of secp256k1 signatures ──> VAA from Pyth's accumulator emitter (Pythnet, chain 26)
       └─ VAA payload ──> Merkle root of all prices in that Pythnet slot
            └─ Merkle proof ──> one price message (feed id, price, conf, expo, publish time)
```

The trust anchor is copied from what Pyth's own Arbitrum contract trusts (`scripts/fetch-fixtures.mjs`
reads it on-chain). As of 2026-09-22 that is **5 signers with a quorum of 3**, via a Pyth-run
Wormhole-compatible receiver (`ReceiverImplementationHalf`, n/2 + 1). It is not Wormhole's 19-guardian
mainnet set.

## Layout

| File | What it is |
|---|---|
| `src/pyth-verifier.js` | Pure, deterministic verifier. Never throws, no clock, no network. |
| `src/trust-anchor.js` | Pinned signer set, quorum and emitter (generated). |
| `src/oracle-contract.js` | `PythOracleContract`: `submitPriceUpdate` tx, monotonic prices, feed allowlist. |
| `src/oracle-protocol.js` | CLI mapping (`/tx --command "pyth <hex>"`), read API `getPrice`, `listFeeds`. |
| `scripts/fetch-fixtures.mjs` | Pulls the trust anchor and real Pyth updates from Arbitrum's public RPC. |
| `test/` | Verifier tests, plus contract tests running inside a real `trac-peer` Peer. |

## Run

```sh
npm install
npm run fetch-fixtures   # optional: refresh trust anchor + real updates
PYTH_API_KEY=... npm run fetch-fixtures   # BTC/USD + ETH/USD from Pyth Hermes
npm test
npm run demo
```

## What it proves, and what it doesn't

Proven:
- Real Pyth updates verify inside a Trac contract in about 5 ms (about 40 ms on the first, cold call).
- Tampered, truncated, under-signed, duplicate-signed, wrong-emitter and forged updates are rejected.
- Old genuinely signed updates can't roll a price back.
- The admin's Feature path can't write prices.

Not covered yet:
- **Real MSB settlement.** Tests use trac-peer's own in-process MSB stub, so contract execution is real
  but no local MSB network was run.
- **Staleness.** Contracts can't read a clock. Halyard's answer is to use the price's own `publishTime` as
  the clock, so a trade, a liquidation and a key's expiry all read the same value; that is a product
  decision, not something this proof of concept implements. Consumers here only get monotonic publish times.
- **Signer rotation.** Changing the trust anchor means shipping a new contract version. Verifying Pyth's
  signer-set-upgrade messages on-chain would remove that step.
- **Publish cadence, measured 2026-09-25.** `scripts/measure-intervals.mjs` polled Hermes for two minutes:
  112 polls, no failures, a fresh BTC/USD and ETH/USD price every second, worst gap 2 seconds. Publish
  times are whole seconds, so that is the finest gap observable this way; Pyth documents 400 ms. Halyard's
  30-second staleness threshold is about 15x the worst gap seen.
- **Tx size.** trac-peer caps tx payloads at 4 KB by default (about 5 feeds per update). The protocol
  raises it to 8 KB.

The fixtures are real BTC/USD and ETH/USD updates from Hermes, the markets the product trades. Since Pyth's
Core upgrade (2026-08-26) Hermes needs an API key, from https://pythdata.app/signup; set `PYTH_API_KEY` and
run `npm run fetch-fixtures` to refresh them. Without a key the script falls back to whatever was pushed
on-chain recently, which in September 2026 meant WBTC/USD, SUI/USD and XAUT/USD on Arbitrum. The verifier
needed no change to go from those feeds to the real ones.
