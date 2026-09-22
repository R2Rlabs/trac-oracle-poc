// Walks through what the oracle contract accepts and rejects, using real Pyth updates.
// Usage: npm run demo
import fs from 'fs';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { verifyPythUpdate } from '../src/pyth-verifier.js';
import { TRUST_ANCHOR } from '../src/trust-anchor.js';
import { FEEDS } from '../src/oracle-contract.js';
import { buildUpdate, makeSigner } from '../test/helpers/build-update.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('../test/fixtures/updates.json', import.meta.url)));
const real = fixtures[0];
const fmt = (p) => (Number(p.price) * 10 ** p.expo).toLocaleString('en-US', { maximumFractionDigits: 4 });

console.log('Trust anchor: Pyth signer set', Object.keys(TRUST_ANCHOR.guardianSets).join(','),
    `(${Object.values(TRUST_ANCHOR.guardianSets)[0].keys.length} signers, quorum ${Object.values(TRUST_ANCHOR.guardianSets)[0].quorum})\n`);

const r = verifyPythUpdate(real.hex, TRUST_ANCHOR);
console.log(`1. Real update from ${real.source}`);
console.log(`   ${r.ok ? 'ACCEPTED' : 'REJECTED'}: ${r.vaa.signatures} valid signatures, slot ${r.slot}`);
for (const p of r.prices) {
    console.log(`   ${(FEEDS[p.feedId] ?? p.feedId.slice(0, 10)).padEnd(10)} ${fmt(p).padStart(12)}  at ${new Date(Number(p.publishTime) * 1000).toISOString()}`);
}

const b = hexToBytes(real.hex);
b[b.length - 30] ^= 1;
console.log(`\n2. Same update with one bit changed in a price proof`);
console.log(`   REJECTED: ${verifyPythUpdate(bytesToHex(b), TRUST_ANCHOR).reason}`);

const forged = buildUpdate({
    signers: [makeSigner(), makeSigner(), makeSigner()],
    emitter: TRUST_ANCHOR.dataSources[0].emitter,
    prices: [{ feedId: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', price: 1n, publishTime: 9_999_999_999n }],
});
console.log(`\n3. Perfectly formatted update setting BTC to $0.00000001, signed by 3 keys the attacker (or subnet admin) controls`);
console.log(`   REJECTED: ${verifyPythUpdate(forged, TRUST_ANCHOR).reason}`);
