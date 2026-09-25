// How much of the staleness budget does our own code use? Usage: node scripts/measure-latency.mjs
//
// This measures the part we control: verifying a signed Pyth update and applying it to contract state.
// It does NOT measure Trac settlement, which needs a funded wallet, a deployed subnet and a live MSB
// connection. Treat the number here as the floor: real latency is this plus fetch time plus settlement.
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyPythUpdate } from '../src/pyth-verifier.js';
import { TRUST_ANCHOR } from '../src/trust-anchor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = Number(process.argv[2] ?? 200);

const fixtures = JSON.parse(await fs.readFile(path.join(ROOT, 'test/fixtures/updates.json'), 'utf8'));
if (!fixtures.length) throw new Error('no fixtures: run npm run fetch-fixtures');

const stats = (samples) => {
    const s = [...samples].sort((a, b) => a - b);
    const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { median: at(0.5), p90: at(0.9), p99: at(0.99), max: s[s.length - 1] };
};
const ms = (x) => `${x.toFixed(2)}ms`;

const bytes = fixtures.map((f) => Uint8Array.from(Buffer.from(f.hex, 'hex')));
console.log(`${fixtures.length} real Pyth updates, ${Math.round(bytes[0].length)} bytes each, ${RUNS} runs per update.\n`);

// Warm up, so we measure steady state rather than first-call compilation.
for (const b of bytes) verifyPythUpdate(b, TRUST_ANCHOR);

const samples = [];
for (let i = 0; i < RUNS; i++) {
    for (const b of bytes) {
        const t = performance.now();
        const result = verifyPythUpdate(b, TRUST_ANCHOR);
        samples.push(performance.now() - t);
        if (!result.ok) throw new Error(`fixture failed to verify: ${result.error}`);
    }
}

const v = stats(samples);
console.log('step                         median      p90      p99      max');
console.log(`verify a signed update     ${ms(v.median).padStart(8)} ${ms(v.p90).padStart(8)} ${ms(v.p99).padStart(8)} ${ms(v.max).padStart(8)}`);
console.log(`
${samples.length} verifications, every one accepted.

What this covers: signature checks, the Merkle proof and decoding, which is the work every Halyard node
repeats for every price. What it does not cover: fetching from Hermes over the network, and settlement on
Trac. Those two are the rest of the 30-second staleness budget and are still unmeasured.`);
