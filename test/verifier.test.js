import test from 'brittle';
import fs from 'fs';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { verifyPythUpdate } from '../src/pyth-verifier.js';
import { TRUST_ANCHOR } from '../src/trust-anchor.js';
import { buildUpdate, makeSigner } from './helpers/build-update.js';

const FIXTURES = JSON.parse(fs.readFileSync(new URL('./fixtures/updates.json', import.meta.url)));
const REAL = FIXTURES[0].hex;
const PYTH_EMITTER = TRUST_ANCHOR.dataSources[0].emitter;
const BTC = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

// Byte offsets inside a real update, derived from its own length fields.
function layout(hex) {
    const b = hexToBytes(hex);
    const vaaStart = 10;
    const vaaLen = (b[8] << 8) | b[9];
    const sigCount = b[vaaStart + 5];
    const bodyStart = vaaStart + 6 + sigCount * 66;
    return {
        b,
        sigCount,
        sigStart: vaaStart + 6,
        bodyStart,
        rootStart: bodyStart + 51 + 17,
        firstPriceStart: vaaStart + vaaLen + 1 + 2 + 33,
    };
}
const flip = (bytes, at) => { const c = bytes.slice(); c[at] ^= 0x01; return bytesToHex(c); };

test('all real Pyth updates from Arbitrum verify', (t) => {
    t.ok(FIXTURES.length > 0, 'have fixtures (npm run fetch-fixtures)');
    for (const f of FIXTURES) {
        const r = verifyPythUpdate(f.hex, TRUST_ANCHOR);
        t.ok(r.ok, `${f.source}: ${r.reason ?? 'ok'}`);
        t.ok(r.prices.length > 0);
        t.ok(r.vaa.signatures >= r.vaa.quorum);
    }
});

test('changing a price by one bit breaks the Merkle proof', (t) => {
    const { b, firstPriceStart } = layout(REAL);
    const r = verifyPythUpdate(flip(b, firstPriceStart + 7), TRUST_ANCHOR);
    t.is(r.ok, false);
    t.ok(/Merkle proof 0/.test(r.reason), r.reason);
});

test('changing the signed Merkle root breaks the signatures', (t) => {
    const { b, rootStart } = layout(REAL);
    const r = verifyPythUpdate(flip(b, rootStart), TRUST_ANCHOR);
    t.is(r.ok, false);
    t.ok(/bad signature/.test(r.reason), r.reason);
});

test('dropping a signature falls below quorum', (t) => {
    const { b, sigStart, sigCount } = layout(REAL);
    // Remove the last signature and fix up the signature count and VAA length.
    const c = new Uint8Array([...b.slice(0, sigStart + (sigCount - 1) * 66), ...b.slice(sigStart + sigCount * 66)]);
    c[sigStart - 1] = sigCount - 1;
    const vaaLen = ((b[8] << 8) | b[9]) - 66;
    c[8] = vaaLen >> 8; c[9] = vaaLen & 0xff;
    const r = verifyPythUpdate(bytesToHex(c), TRUST_ANCHOR);
    t.is(r.ok, false);
    t.ok(/only 2 guardian signatures, need 3/.test(r.reason), r.reason);
});

test('repeating one guardian signature does not count twice', (t) => {
    const { b, sigStart } = layout(REAL);
    const c = b.slice();
    c.set(b.slice(sigStart, sigStart + 66), sigStart + 66); // signature #2 := copy of signature #1
    const r = verifyPythUpdate(bytesToHex(c), TRUST_ANCHOR);
    t.is(r.ok, false);
    t.ok(/not strictly ascending/.test(r.reason), r.reason);
});

test('an attacker-signed update is rejected, even when perfectly formed', (t) => {
    const attackers = [makeSigner(), makeSigner(), makeSigner()];
    const forged = buildUpdate({
        signers: attackers,
        emitter: PYTH_EMITTER,
        prices: [{ feedId: BTC, price: 1n, publishTime: 9_999_999_999n }], // BTC at $0.00000001
    });
    const r = verifyPythUpdate(forged, TRUST_ANCHOR);
    t.is(r.ok, false);
    t.ok(/bad signature from guardian 0/.test(r.reason), r.reason);

    // Sanity check on the builder and the parser: the same bytes pass if we trusted the attacker.
    const attackerAnchor = {
        guardianSets: { 1: { quorum: 3, keys: attackers.map((a) => a.address) } },
        dataSources: TRUST_ANCHOR.dataSources,
    };
    const ok = verifyPythUpdate(forged, attackerAnchor);
    t.ok(ok.ok, ok.reason);
    t.is(ok.prices[0].price, 1n);
});

test('a validly signed update from the wrong emitter is rejected', (t) => {
    const signers = [makeSigner(), makeSigner(), makeSigner()];
    const anchor = {
        guardianSets: { 1: { quorum: 3, keys: signers.map((s) => s.address) } },
        dataSources: TRUST_ANCHOR.dataSources,
    };
    const update = buildUpdate({
        signers,
        emitter: 'aa'.repeat(32),
        prices: [{ feedId: BTC, price: 1n, publishTime: 1n }],
    });
    const r = verifyPythUpdate(update, anchor);
    t.is(r.ok, false);
    t.ok(/trusted Pyth emitter/.test(r.reason), r.reason);
});

test('an unknown guardian set index is rejected', (t) => {
    const { b } = layout(REAL);
    const c = b.slice();
    c[14] = 99; // low byte of guardian set index
    const r = verifyPythUpdate(bytesToHex(c), TRUST_ANCHOR);
    t.is(r.ok, false);
    t.ok(/unknown guardian set 99/.test(r.reason), r.reason);
});

test('garbage and truncated input is rejected without throwing', (t) => {
    const inputs = ['', 'zz', '504e4155', REAL.slice(0, 100), REAL.slice(0, REAL.length - 2), REAL + '00', null, 42, {}];
    for (const input of inputs) {
        const r = verifyPythUpdate(input, TRUST_ANCHOR);
        t.is(r.ok, false, `${String(input).slice(0, 12)}: ${r.reason}`);
    }
    // Every one-byte truncation of a real update.
    let rejected = 0;
    for (let n = 0; n < REAL.length; n += 2) if (!verifyPythUpdate(REAL.slice(0, n), TRUST_ANCHOR).ok) rejected++;
    t.is(rejected, REAL.length / 2);
});

test('verification is deterministic', (t) => {
    const a = JSON.stringify(verifyPythUpdate(REAL, TRUST_ANCHOR), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    for (let i = 0; i < 5; i++) {
        const b = JSON.stringify(verifyPythUpdate(REAL, TRUST_ANCHOR), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
        t.is(b, a);
    }
});
