// How often does a fresh Pyth price actually land? Measures the gaps between publishTimes, which is
// what Halyard's staleness threshold has to tolerate.
//
// With PYTH_API_KEY set it polls Hermes and measures Pythnet's own publish cadence, which is the
// number the threshold should be set against.
//
// Without a key it falls back to PriceFeedUpdate events from Pyth's contract on a pull chain, which
// measures how often somebody paid to push a fresh price, not how fast Pythnet publishes. Observed
// 2026-09-24: a median of 282s between updates on Arbitrum and 1,190s on Base, which is demand being
// low rather than Pyth being slow.
//
// Usage: node scripts/measure-intervals.mjs [blocks]
//        PYTH_API_KEY=... node scripts/measure-intervals.mjs
//        RPC=https://mainnet.base.org PYTH_ADDRESS=0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a node scripts/measure-intervals.mjs
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

const RPC = process.env.RPC ?? 'https://arb1.arbitrum.io/rpc';
const HERMES_URL = process.env.PYTH_HERMES_URL ?? 'https://hermes.pyth.network';
const PYTH_API_KEY = process.env.PYTH_API_KEY;
const SAMPLE_SECONDS = Number(process.env.SAMPLE_SECONDS ?? 120);

// The markets the product trades.
const FEEDS = {
    'BTC/USD': 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    'ETH/USD': 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
};

// Polls Hermes twice a second and records each distinct publishTime it serves.
async function measureHermes() {
    const url = `${HERMES_URL}/v2/updates/price/latest?${Object.values(FEEDS).map((id) => `ids[]=0x${id}`).join('&')}`;
    const seen = new Map(Object.keys(FEEDS).map((name) => [name, new Set()]));
    const until = Date.now() + SAMPLE_SECONDS * 1000;
    console.log(`Polling Hermes for ${SAMPLE_SECONDS}s…`);
    let polls = 0, failures = 0, firstError = '';
    while (Date.now() < until) {
        try {
            const res = await fetch(url, { headers: { Authorization: `Bearer ${PYTH_API_KEY}` } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            for (const p of json.parsed ?? []) {
                const name = Object.keys(FEEDS).find((n) => FEEDS[n] === String(p.id).replace(/^0x/, ''));
                if (name) seen.get(name).add(Number(p.price.publish_time));
            }
            polls++;
        } catch (err) {
            if (failures++ === 0) firstError = err.message;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`\n${polls} polls, ${failures} failures${firstError ? ` (first: ${firstError})` : ''}.\n`);
    console.log('feed       prices seen   median gap    p90     max   (seconds between fresh prices)');
    for (const [name, times] of seen) {
        const sorted = [...times].sort((a, b) => a - b);
        const gaps = sorted.slice(1).map((t, i) => t - sorted[i]).sort((a, b) => a - b);
        if (!gaps.length) { console.log(`${name.padEnd(10)} ${String(sorted.length).padStart(11)}   (not enough data)`); continue; }
        const at = (p) => gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))];
        console.log([name.padEnd(10), String(sorted.length).padStart(11), `${at(0.5)}s`.padStart(12), `${at(0.9)}s`.padStart(7), `${gaps[gaps.length - 1]}s`.padStart(7)].join(' '));
    }
    console.log('\nThis is Pythnet\'s publish cadence: the number the staleness threshold should be set against.');
}

if (PYTH_API_KEY) {
    await measureHermes();
    process.exit(0);
}
console.log('No PYTH_API_KEY set: falling back to on-chain updates, which measure demand to push, not Pyth.\n');
const PYTH = process.env.PYTH_ADDRESS ?? '0xff1a0f4744e8582DF1aE09D5611b887B6a12925C';
const BLOCKS = Number(process.argv[2] ?? 6000);   // Arbitrum blocks are ~0.25s, so 6000 ≈ 25 minutes
const WINDOW = 500;                                // getLogs window the public RPC accepts

const topic0 = '0x' + bytesToHex(keccak_256(utf8ToBytes('PriceFeedUpdate(bytes32,uint64,int64,uint64)')));

async function rpc(method, params) {
    const res = await fetch(RPC, {
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
        batch = await rpc('eth_getLogs', [{ address: PYTH, topics: [topic0], fromBlock: hex(start), toBlock: hex(end) }]);
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
