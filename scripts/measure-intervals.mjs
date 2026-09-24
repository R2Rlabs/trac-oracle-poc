// How often does a fresh Pyth price actually land? Measures the gaps between accepted publishTimes,
// which is what Halyard's staleness threshold has to tolerate.
//
// Hermes needs an API key, so this reads what is observable without one: PriceFeedUpdate events from
// Pyth's contract on Arbitrum. That is a pull chain, so it measures how often somebody paid to push a
// fresh price, not how fast Pythnet publishes. Halyard is also pull-based, so this is the closer
// number for us: it is the cadence a busy market produces in practice.
//
// Usage: node scripts/measure-intervals.mjs [blocks]
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

const ARB_RPC = process.env.ARB_RPC ?? 'https://arb1.arbitrum.io/rpc';
const PYTH_ARBITRUM = '0xff1a0f4744e8582DF1aE09D5611b887B6a12925C';
const BLOCKS = Number(process.argv[2] ?? 6000);   // Arbitrum blocks are ~0.25s, so 6000 ≈ 25 minutes
const WINDOW = 500;                                // getLogs window the public RPC accepts

const topic0 = '0x' + bytesToHex(keccak_256(utf8ToBytes('PriceFeedUpdate(bytes32,uint64,int64,uint64)')));

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

const hex = (n) => '0x' + n.toString(16);

// PriceFeedUpdate: id is indexed (topic 1); data is publishTime, price, conf, each a 32-byte word.
const publishTimeOf = (log) => Number(BigInt('0x' + log.data.slice(2).slice(0, 64)));

const head = Number(await rpc('eth_blockNumber', []));
const from = head - BLOCKS;
console.log(`Scanning Arbitrum blocks ${from}–${head} for Pyth price updates…`);

const byFeed = new Map();
let logs = 0;
for (let start = from; start <= head; start += WINDOW) {
    const end = Math.min(start + WINDOW - 1, head);
    let batch;
    try {
        batch = await rpc('eth_getLogs', [{ address: PYTH_ARBITRUM, topics: [topic0], fromBlock: hex(start), toBlock: hex(end) }]);
    } catch (err) {
        console.warn(`  blocks ${start}–${end}: ${err.message}`);
        continue;
    }
    logs += batch.length;
    for (const log of batch) {
        const id = log.topics[1].slice(2);
        if (!byFeed.has(id)) byFeed.set(id, []);
        byFeed.get(id).push(publishTimeOf(log));
    }
}

const stats = (times) => {
    const sorted = [...new Set(times)].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((t, i) => t - sorted[i]);
    if (!gaps.length) return null;
    const ordered = [...gaps].sort((a, b) => a - b);
    const at = (p) => ordered[Math.min(ordered.length - 1, Math.floor(p * ordered.length))];
    return {
        updates: sorted.length,
        span: sorted[sorted.length - 1] - sorted[0],
        median: at(0.5), p90: at(0.9), p99: at(0.99), max: ordered[ordered.length - 1],
    };
};

const rows = [...byFeed.entries()]
    .map(([id, times]) => ({ id, ...(stats(times) ?? {}) }))
    .filter((r) => r.updates > 3)
    .sort((a, b) => b.updates - a.updates);

console.log(`\n${logs} update events across ${byFeed.size} feeds; ${rows.length} feeds with enough data.\n`);
console.log('feed (first 8)   updates   span   median    p90    p99    max   (seconds between fresh prices)');
for (const r of rows.slice(0, 12)) {
    console.log([
        r.id.slice(0, 8).padEnd(14),
        String(r.updates).padStart(7),
        `${r.span}s`.padStart(7),
        `${r.median}s`.padStart(7),
        `${r.p90}s`.padStart(6),
        `${r.p99}s`.padStart(6),
        `${r.max}s`.padStart(6),
    ].join(' '));
}

const allGaps = rows.flatMap((r) => [r.median, r.p90, r.p99, r.max]);
if (allGaps.length) {
    const worst = Math.max(...rows.map((r) => r.max));
    const typicalMedian = rows.map((r) => r.median).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    console.log(`\nTypical feed: a fresh price every ${typicalMedian}s (median of medians).`);
    console.log(`Worst gap seen on any feed in this window: ${worst}s.`);
}
