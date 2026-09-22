import test from 'brittle';
import fs from 'fs';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { withOraclePeer, memoryStorage } from './helpers/peer.js';
import { buildUpdate, makeSigner } from './helpers/build-update.js';
import { priceKey } from '../src/oracle-contract.js';
import { TRUST_ANCHOR } from '../src/trust-anchor.js';

// Fixtures come newest first; sort oldest first so the ordering tests read naturally.
const FIXTURES = JSON.parse(fs.readFileSync(new URL('./fixtures/updates.json', import.meta.url))).reverse();
const OLDEST = FIXTURES[0].hex;
const NEWEST = FIXTURES[FIXTURES.length - 1].hex;
const WBTC = 'c9d8b075a5c69303365ae23633d4e085199bf5c520a3b90fed1322a0342ffc33';
const BTC = 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

const submit = (update) => ({ type: 'submitPriceUpdate', value: { update } });

// Shapes an op the way trac-peer's apply loop hands a confirmed tx to the contract.
let txCounter = 0;
function txOp(peer, dispatch, submitterPubKey = peer.wallet.publicKey) {
    txCounter++;
    return {
        type: 'tx',
        key: txCounter.toString(16).padStart(64, '0'),
        value: { dispatch, ipk: submitterPubKey, wp: peer.wallet.publicKey },
    };
}

test('a real Pyth update settles through the trac-peer tx path (simulated)', async (t) => {
    await withOraclePeer(async (peer) => {
        const started = performance.now();
        const res = await peer.protocol.instance.simulateTransaction(peer.wallet.publicKey, submit(NEWEST));
        const ms = performance.now() - started;
        t.alike(res.updated.sort(), ['SUI/USD', 'WBTC/USD', 'XAUT/USD']);
        t.comment(`contract execution incl. verification: ${ms.toFixed(1)} ms`);
    });
});

test('a tampered update is rejected by the contract', async (t) => {
    await withOraclePeer(async (peer) => {
        const b = hexToBytes(NEWEST);
        b[b.length - 30] ^= 1; // inside the last Merkle proof
        const res = await peer.protocol.instance.simulateTransaction(peer.wallet.publicKey, submit(bytesToHex(b)));
        t.is(res?.name, 'AssertionError');
        t.ok(/Merkle proof/.test(res.message), res.message);
    });
});

test('non-hex payloads are rejected by the schema before any verification', async (t) => {
    await withOraclePeer(async (peer) => {
        const res = await peer.protocol.instance.simulateTransaction(peer.wallet.publicKey, submit('not hex at all!'));
        t.ok(res instanceof Error);
        t.is(res.message, 'Invalid schema.');
    });
});

test('prices only move forward: old signed updates cannot roll the price back', async (t) => {
    await withOraclePeer(async (peer) => {
        const contract = peer.contract.instance;
        const storage = memoryStorage();

        const first = await contract.execute(txOp(peer, submit(NEWEST)), storage);
        t.alike(first.updated.sort(), ['SUI/USD', 'WBTC/USD', 'XAUT/USD']);
        const stored = storage.values.get(priceKey(WBTC));
        t.is(stored.symbol, 'WBTC/USD');
        t.is(stored.submittedBy, peer.wallet.publicKey);

        // Replaying an older, genuinely signed update: valid signatures, but stale.
        const replay = await contract.execute(txOp(peer, submit(OLDEST)), storage);
        t.is(replay?.name, 'AssertionError');
        t.ok(/no newer prices/.test(replay.message), replay.message);
        t.alike(storage.values.get(priceKey(WBTC)), stored, 'price unchanged');

        // Resubmitting the same update is also a no-op.
        const again = await contract.execute(txOp(peer, submit(NEWEST)), storage);
        t.is(again?.name, 'AssertionError');
    });
});

test('updates apply in order when submitted oldest to newest', async (t) => {
    await withOraclePeer(async (peer) => {
        const storage = memoryStorage();
        let lastTime = 0n;
        for (const f of FIXTURES) {
            const res = await peer.contract.instance.execute(txOp(peer, submit(f.hex)), storage);
            t.ok(Array.isArray(res?.updated), f.source);
            const time = BigInt(storage.values.get(priceKey(WBTC)).publishTime);
            t.ok(time > lastTime);
            lastTime = time;
        }
    });
});

test('the subnet admin has no way to write a price', async (t) => {
    await withOraclePeer(async (peer) => {
        const contract = peer.contract.instance;
        const storage = memoryStorage();
        t.alike(Object.keys(contract.metadata.features), [], 'no Features registered');

        // What an admin-signed Feature append looks like once it reaches the contract.
        const featureOp = {
            type: 'feature',
            key: 'price_feature_BTC',
            value: { dispatch: { type: 'price_feature', address: peer.wallet.publicKey, value: { feedId: BTC, price: '1' } } },
        };
        await contract.execute(featureOp, storage);
        t.is(storage.values.size, 0, 'feature op wrote nothing');

        // An update signed by keys the admin controls, perfectly formed, still fails verification.
        const forged = buildUpdate({
            signers: [makeSigner(), makeSigner(), makeSigner()],
            emitter: TRUST_ANCHOR.dataSources[0].emitter,
            prices: [{ feedId: BTC, price: 1n, publishTime: 9_999_999_999n }],
        });
        const res = await contract.execute(txOp(peer, submit(forged)), storage);
        t.is(res?.name, 'AssertionError');
        t.ok(/bad signature/.test(res.message), res.message);
        t.is(storage.values.size, 0);
    });
});

test('read API is exposed through the peer schema', async (t) => {
    await withOraclePeer(async (peer) => {
        const methods = peer.protocol.instance.getApiSchema().methods;
        t.ok(methods.getPrice, 'getPrice exposed');
        t.ok(methods.listFeeds, 'listFeeds exposed');
        t.is(await peer.protocol.instance.api.getPrice('BTC/USD'), null, 'nothing stored yet');
        t.is(await peer.protocol.instance.api.getPrice('DOGE/USD'), null, 'untracked feed');
    });
});
