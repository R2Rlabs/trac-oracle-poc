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

## Measuring settlement on a real subnet

`scripts/measure-settlement.mjs` times how long a price update takes to go from submitted to agreed:
the last unmeasured part of Halyard's 30-second staleness budget. It submits real signed Pyth updates
and waits until each one is readable from the signed view.

It needs a real network, which means three things first:

1. A subnet deployed with this contract. Use trac-peer's runner, then `/deploy_subnet` in its console;
   it prints the subnet bootstrap.
2. This harness's peer added as a writer on that subnet (`/add_writer --key <its writer key>`), which
   the script tells you if it is missing.
3. TNK in the peer's MSB address, which the script prints. Each transaction costs 0.03 TNK, so 20
   samples is 0.6 TNK.

```sh
PYTH_API_KEY=... node scripts/measure-settlement.mjs --subnet-bootstrap=SUBNET_HEX --samples=20
```

The MSB bootstrap and channel come from the chosen network (`--env=mainnet` by default), so they need no
flags. For the record, from `trac-msb` and confirmed against Trac's own `main_settlement_bus` v0.2.21:

| Network | MSB bootstrap | Channel |
| --- | --- | --- |
| mainnet | `acbc3a4344d3a804101d40e53db1dda82b767646425af73599d4cd6577d69685` | `0000trac0network0msb0mainnet0000` |
| testnet1 | `c184f4ad8e9cf5e911f9415b60e7dcfb30aed73ebd8a402ef68e1b154624f5ef` | `1111trac1network1msb1testnet1111` |

**Run against Trac mainnet, 25 September 2026.** Twenty samples on a deployed subnet, 0.6 TNK, none
failed: median **10.4s**, p90 **26.3s**, max **28.7s**, measured from submitted to readable in the
signed view. The first transaction on a cold node took **41s** — connection setup, not consensus —
and every later sample on the same node was under 30s.

That is one subnet, one node, one connection: it is a number for our own staleness budget, not a
benchmark of the network. It moved our staleness threshold from 30s to 60s, because a normal 28s
settlement was one bad moment from rejecting honest trades, and the economic protection is the
per-order price band rather than staleness.

## Fixtures

The fixtures are real BTC/USD and ETH/USD updates from Hermes, the markets the product trades. Since Pyth's
Core upgrade (2026-08-26) Hermes needs an API key, from https://pythdata.app/signup; set `PYTH_API_KEY` and
run `npm run fetch-fixtures` to refresh them. Without a key the script falls back to whatever was pushed
on-chain recently, which in September 2026 meant WBTC/USD, SUI/USD and XAUT/USD on Arbitrum. The verifier
needed no change to go from those feeds to the real ones.
