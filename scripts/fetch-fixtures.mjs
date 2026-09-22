// Pulls real, signed oracle data and writes it for the tests:
//   1. The trust anchor Pyth's own Arbitrum contract uses: the signer set of its Wormhole-compatible
//      receiver, and its valid data source (emitter). Read from Arbitrum's public RPC and written to
//      src/trust-anchor.js, which the contract pins in code.
//      Note: Pyth no longer verifies against Wormhole's 19-guardian mainnet set. Its receiver has its
//      own small signer set and accepts a 1/2 + 1 majority (ReceiverImplementationHalf.sol in
//      github.com/pyth-network/pyth-crosschain).
//   2. Pyth price updates (PNAU blobs), each verified with src/pyth-verifier.js before it is kept,
//      written to test/fixtures/updates.json:
//      - With PYTH_API_KEY set: BTC/USD + ETH/USD, the markets the product trades, from Hermes.
//        Since Pyth's Core upgrade (2026-08-26) Hermes requires an API key.
//      - Without a key: whatever feeds were recently pushed to Pyth on Arbitrum, taken from
//        transaction calldata. As of 2026-09-22 nobody pushes BTC/USD or ETH/USD there.
//
// Usage: npm run fetch-fixtures
//        PYTH_API_KEY=... npm run fetch-fixtures
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { verifyPythUpdate } from '../src/pyth-verifier.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARB_RPC = process.env.ARB_RPC ?? 'https://arb1.arbitrum.io/rpc';
const HERMES_URL = process.env.PYTH_HERMES_URL ?? 'https://hermes.pyth.network';
const PYTH_API_KEY = process.env.PYTH_API_KEY;
const PYTH_ARBITRUM = '0xff1a0f4744e8582DF1aE09D5611b887B6a12925C';
const WANTED_UPDATES = Number(process.env.WANTED_UPDATES ?? 5);

// The markets the product trades.
const BTC_USD = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
const ETH_USD = 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';

const selector = (sig) => '0x' + bytesToHex(keccak_256(utf8ToBytes(sig))).slice(0, 8);
const topic = (sig) => '0x' + bytesToHex(keccak_256(utf8ToBytes(sig)));

async function rpc(method, params) {
    const res = await fetch(ARB_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
    return json.result;
}

const call = async (to, data) => (await rpc('eth_call', [{ to, data }, 'latest'])).slice(2);
const words = (hex) => hex.match(/.{64}/g);

async function fetchTrustAnchor() {
    const receiver = '0x' + (await call(PYTH_ARBITRUM, selector('wormhole()'))).slice(-40);
    const index = parseInt(await call(receiver, selector('getCurrentGuardianSetIndex()')), 16);
    // getGuardianSet returns struct (address[] keys, uint32 expirationTime):
    // [offset to struct][offset to keys][expiration][len][key...]
    const gs = words(await call(receiver, selector('getGuardianSet(uint32)') + index.toString(16).padStart(64, '0')));
    const keys = gs.slice(4, 4 + parseInt(gs[3], 16)).map((w) => w.slice(24));
    // validDataSources returns DataSource[] {uint16 chainId, bytes32 emitterAddress}: [offset][len][chain, emitter]...
    const ds = words(await call(PYTH_ARBITRUM, selector('validDataSources()')));
    const sources = [];
    for (let i = 0; i < parseInt(ds[1], 16); i++) {
        sources.push({ chain: parseInt(ds[2 + i * 2], 16), emitter: ds[3 + i * 2] });
    }
    return { receiver, index, keys, quorum: Math.floor(keys.length / 2) + 1, sources };
}

// BTC/USD + ETH/USD at WANTED_UPDATES different moments over the last ~10 minutes.
async function fetchFromHermes(trust) {
    const now = Math.floor(Date.now() / 1000);
    const updates = [];
    for (let i = 0; i < WANTED_UPDATES; i++) {
        const at = now - 60 - i * 120;
        const url = `${HERMES_URL}/v2/updates/price/${at}?ids[]=${BTC_USD}&ids[]=${ETH_USD}&encoding=hex&parsed=false`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${PYTH_API_KEY}` } });
        if (!res.ok) throw new Error(`Hermes ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const hex = (await res.json()).binary.data[0];
        const r = verifyPythUpdate(hex, trust);
        if (!r.ok) throw new Error(`Hermes update at ${at} failed verification: ${r.reason}`);
        updates.push({ source: `hermes publish_time ${at}`, hex });
    }
    return updates; // newest first
}

// Pulls every PNAU blob out of a transaction's calldata. Calldata may come straight to Pyth or
// through a router; either way each update is an ABI `bytes` value, so the 32-byte word before
// the "PNAU" magic holds its length.
function extractUpdates(input) {
    const blobs = [];
    let at = input.indexOf('504e4155');
    while (at !== -1) {
        if (at >= 64 && at % 2 === 0) {
            const len = parseInt(input.slice(at - 64, at), 16);
            const blob = input.slice(at, at + len * 2);
            if (len > 0 && blob.length === len * 2) blobs.push(blob);
        }
        at = input.indexOf('504e4155', at + 8);
    }
    return blobs;
}

// Whatever feeds were recently pushed to Pyth on Arbitrum.
async function fetchFromArbitrum(trust) {
    const latest = parseInt(await rpc('eth_blockNumber', []), 16);
    const eventTopic = topic('PriceFeedUpdate(bytes32,uint64,int64,uint64)');
    const updates = [];
    const seen = new Set();
    const seenTx = new Set();
    // Walk back in small windows; logs within a window come oldest first, so reverse them.
    for (let to = latest; updates.length < WANTED_UPDATES && to > latest - 50_000; to -= 500) {
        const logs = await rpc('eth_getLogs', [{
            address: PYTH_ARBITRUM,
            topics: [eventTopic],
            fromBlock: '0x' + (to - 499).toString(16),
            toBlock: '0x' + to.toString(16),
        }]);
        for (const log of logs.reverse()) {
            if (updates.length >= WANTED_UPDATES || seenTx.has(log.transactionHash)) continue;
            seenTx.add(log.transactionHash);
            const input = (await rpc('eth_getTransactionByHash', [log.transactionHash])).input.slice(2);
            for (const hex of extractUpdates(input)) {
                if (updates.length >= WANTED_UPDATES || seen.has(hex) || !verifyPythUpdate(hex, trust).ok) continue;
                seen.add(hex);
                updates.push({ source: `arbitrum tx ${log.transactionHash}`, hex });
            }
        }
    }
    return updates; // newest first
}

const t = await fetchTrustAnchor();
console.log(`Pyth receiver ${t.receiver}: guardian set #${t.index}, ${t.keys.length} signers, quorum ${t.quorum}`);
console.log('Valid data sources:', t.sources);
await fs.writeFile(path.join(ROOT, 'src', 'trust-anchor.js'),
    `// Generated by scripts/fetch-fixtures.mjs on ${new Date().toISOString().slice(0, 10)} from what Pyth's own contract\n` +
    `// on Arbitrum (${PYTH_ARBITRUM}) trusts. Pinned in code: changing it means shipping a new contract version.\n` +
    `export const TRUST_ANCHOR = {\n` +
    `    // Signers of Pyth's Wormhole-compatible receiver ${t.receiver}.\n` +
    `    // Quorum is 1/2 + 1, matching ReceiverImplementationHalf.sol in pyth-network/pyth-crosschain.\n` +
    `    guardianSets: {\n        ${t.index}: {\n            quorum: ${t.quorum},\n            keys: [\n` +
    t.keys.map((k) => `                '${k}',`).join('\n') +
    `\n            ],\n        },\n    },\n` +
    `    // Wormhole chain 26 is Pythnet; the emitter is Pyth's accumulator.\n` +
    `    dataSources: [\n` + t.sources.map((d) => `        { chain: ${d.chain}, emitter: '${d.emitter}' },`).join('\n') + `\n    ],\n};\n`);

const trust = { guardianSets: { [t.index]: { quorum: t.quorum, keys: t.keys } }, dataSources: t.sources };
let updates;
if (PYTH_API_KEY) {
    updates = await fetchFromHermes(trust);
    console.log(`BTC/USD + ETH/USD updates from Hermes: ${updates.length}`);
} else {
    console.warn('No PYTH_API_KEY: falling back to feeds recently pushed on Arbitrum (not BTC/ETH as of 2026-09-22).');
    updates = await fetchFromArbitrum(trust);
    console.log(`Pyth updates extracted from Arbitrum: ${updates.length}`);
}
if (updates.length === 0) throw new Error('no verified updates found; fixtures left unchanged');
await fs.mkdir(path.join(ROOT, 'test', 'fixtures'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'test', 'fixtures', 'updates.json'), JSON.stringify(updates, null, 2));
