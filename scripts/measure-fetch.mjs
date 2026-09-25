// How long does fetching a price take, and how old is it when it arrives?
// Usage: PYTH_API_KEY=... node scripts/measure-fetch.mjs [samples]
//
// This is the second part of the staleness budget: the round trip to Hermes, plus how far behind the
// served price already is. The third part, Trac settlement, still needs a live subnet to measure.
const KEY = process.env.PYTH_API_KEY;
if (!KEY) { console.error('Set PYTH_API_KEY first.'); process.exit(1); }

const SAMPLES = Number(process.argv[2] ?? 20);
const IDS = [
    'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', // BTC/USD
    'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace', // ETH/USD
];
const url = `https://hermes.pyth.network/v2/updates/price/latest?${IDS.map((i) => `ids[]=0x${i}`).join('&')}`;

const times = [], ages = [], sizes = [];
for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
    const json = await res.json();
    times.push(performance.now() - t);
    const now = Math.floor(Date.now() / 1000);
    for (const p of json.parsed ?? []) ages.push(now - Number(p.price.publish_time));
    for (const b of json.binary?.data ?? []) sizes.push(b.length / 2);
    await new Promise((r) => setTimeout(r, 250));
}

const stat = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { median: at(0.5), p90: at(0.9), max: s[s.length - 1] };
};

const f = stat(times), g = stat(ages), z = stat(sizes);
console.log(`${SAMPLES} fetches of BTC/USD + ETH/USD from Hermes.\n`);
console.log(`round trip        median ${f.median.toFixed(0)}ms   p90 ${f.p90.toFixed(0)}ms   max ${f.max.toFixed(0)}ms`);
console.log(`price age on arrival  median ${g.median}s    p90 ${g.p90}s    max ${g.max}s`);
console.log(`update size       median ${Math.round(z.median)} bytes`);
console.log(`
Add the ~5ms verification each Halyard node does, and the only unmeasured part of the 30-second
staleness budget is Trac settlement.`);
