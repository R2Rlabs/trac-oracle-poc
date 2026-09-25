// How long does a price update take to settle on Trac? This is the last unmeasured part of Halyard's
// 30-second staleness budget: fetching takes ~0.5s, verifying ~5ms, and settlement is everything else.
//
// It submits real, signed Pyth updates to a real subnet and times two things per sample:
//   broadcast   how long the tx call takes to return
//   settled     until the price is readable from the SIGNED view, which is the number that matters
//
// Usage:
//   PYTH_API_KEY=... node scripts/measure-settlement.mjs --subnet-bootstrap=<hex32> [--samples=20]
//
// The MSB bootstrap and channel default to the chosen network's own values (--env=mainnet by default;
// testnet1 and development also work), so they only need passing for a private network.
//
// It starts a local MSB node that joins the given network, and a peer running the oracle contract.
// The peer's MSB address must hold TNK: it pays 0.03 TNK per transaction. The script prints the
// address and stops if the balance is zero, rather than failing later for a reason that looks technical.
import path from 'path';
import fs from 'fs/promises';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import { MainSettlementBus } from 'trac-msb/src/index.js';
import { createConfig as createMsbConfig, ENV as MSB_ENV } from 'trac-msb/src/config/env.js';
import { Peer, Wallet, createConfig as createPeerConfig, ENV as PEER_ENV } from 'trac-peer';
import PythOracleProtocol from '../src/oracle-protocol.js';
import PythOracleContract, { FEEDS } from '../src/oracle-contract.js';

const args = Object.fromEntries(process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || '1']; }));

const need = (name, env) => {
    const v = args[name] ?? process.env[env];
    if (!v) { console.error(`Missing --${name} (or ${env}). See the usage note at the top of this file.`); process.exit(1); }
    return String(v).trim();
};

const KEY = process.env.PYTH_API_KEY;
if (!KEY) { console.error('Set PYTH_API_KEY: the harness submits real Pyth updates.'); process.exit(1); }

const envName = (args.env ?? process.env.TRAC_ENV ?? 'mainnet').toUpperCase();
if (!PEER_ENV[envName] || !MSB_ENV[envName]) { console.error(`Unknown --env ${envName}. Use mainnet, testnet1 or development.`); process.exit(1); }

// trac-msb ships each network's MSB bootstrap and channel, so they only need overriding for a private
// network. Verified against Trac's own main_settlement_bus repo (v0.2.21) on 2026-09-25.
const envDefaults = createMsbConfig(MSB_ENV[envName], {});
// The config hands these back as buffers; the flags take hex and a plain string.
const defaultBootstrap = b4a.toString(envDefaults.bootstrap, 'hex');
const defaultChannel = b4a.toString(envDefaults.channel, 'utf8').replace(/\0+$/, '');
const msbBootstrap = String(args['msb-bootstrap'] ?? process.env.MSB_BOOTSTRAP ?? defaultBootstrap).toLowerCase();
const msbChannel = args['msb-channel'] ?? process.env.MSB_CHANNEL ?? defaultChannel;
const subnetBootstrap = need('subnet-bootstrap', 'SUBNET_BOOTSTRAP').toLowerCase();
const subnetChannel = args['subnet-channel'] ?? process.env.SUBNET_CHANNEL ?? 'trac-peer-subnet';
const SAMPLES = Number(args.samples ?? 20);
const INTERVAL = Number(args.interval ?? 5000);          // gap between samples, ms
const TIMEOUT = Number(args.timeout ?? 120_000);          // give up on a sample after this
const STORES = args['stores-directory'] ?? 'stores/';

for (const [name, hex] of [['msb-bootstrap', msbBootstrap], ['subnet-bootstrap', subnetBootstrap]]) {
    if (!/^[0-9a-f]{64}$/.test(hex)) { console.error(`--${name} must be 32-byte hex (64 chars).`); process.exit(1); }
}
if (msbBootstrap === subnetBootstrap) { console.error('The subnet bootstrap cannot equal the MSB bootstrap.'); process.exit(1); }
const BTC = Object.keys(FEEDS).find((id) => FEEDS[id] === 'BTC/USD') ?? Object.keys(FEEDS)[0];

async function freshUpdate() {
    const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x${BTC}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) throw new Error(`Hermes HTTP ${res.status}`);
    const json = await res.json();
    const hex = json.binary.data[0];
    const publishTime = Number(json.parsed[0].price.publish_time);
    return { hex, publishTime };
}

const stat = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { median: at(0.5), p90: at(0.9), max: s[s.length - 1] };
};
const secs = (ms) => `${(ms / 1000).toFixed(2)}s`;

// --- start a local MSB node that joins the given network, then the peer on top of it ---------------

const msbConfig = createMsbConfig(MSB_ENV[envName], {
    bootstrap: msbBootstrap,
    channel: msbChannel,
    storeName: args['msb-store-name'] ?? 'latency-msb',
    messageValidatorResponseTimeout: Number(args['send-timeout'] ?? 60000),
    storesDirectory: args['msb-stores-directory'] ?? STORES,
});

async function loadOrCreateWallet(keyPairPath, options) {
    const wallet = new PeerWallet(options);
    try {
        await fs.access(keyPairPath);
        wallet.importFromFile(keyPairPath, b4a.alloc(0));
    } catch {
        await fs.mkdir(path.dirname(keyPairPath), { recursive: true });
        await wallet.generateKeyPair();
        await wallet.exportToFile(keyPairPath, b4a.alloc(0));
        console.log(`Created a new wallet at ${keyPairPath}. Back it up or delete it when you are done.`);
    }
    return wallet;
}

const msbWallet = await loadOrCreateWallet(msbConfig.keyPairPath, {
    networkPrefix: msbConfig.addressPrefix,
    derivationPath: msbConfig.derivationPath,
});
const msb = new MainSettlementBus(msbConfig, msbWallet);
await msb.ready();

const peerStoreName = args['peer-store-name'] ?? 'oracle-subnet';
const peerConfig = createPeerConfig(PEER_ENV[envName], {
    storesDirectory: STORES.endsWith('/') ? STORES : STORES + '/',
    storeName: peerStoreName,
    bootstrap: b4a.from(subnetBootstrap, 'hex'),
    channel: subnetChannel,
});
const peerWallet = new Wallet();
const peerKeyPath = path.join(STORES, peerStoreName, 'db', 'keypair.json');
try {
    await fs.access(peerKeyPath);
    peerWallet.importFromFile(peerKeyPath, b4a.alloc(0));
} catch {
    await fs.mkdir(path.dirname(peerKeyPath), { recursive: true });
    await peerWallet.generateKeyPair();
    await peerWallet.exportToFile(peerKeyPath, b4a.alloc(0));
}

const peer = new Peer({ config: peerConfig, wallet: peerWallet, protocol: PythOracleProtocol, contract: PythOracleContract, msb });
await peer.ready();

console.log(`\nMSB address: ${msbWallet.address ?? '(unknown)'}`);
console.log(`Peer key:    ${peerWallet.publicKey}`);
console.log(`Subnet:      ${subnetBootstrap} on channel "${subnetChannel}"`);
console.log(`MSB:         ${msbBootstrap.slice(0, 16)}… on channel "${msbChannel}" (${envName})`);

if (peer.base?.writable === false) {
    console.error(`\nThis peer is not a writer on that subnet, so it cannot submit. Have the subnet admin run:
  /add_writer --key <this peer's writer key>
then run this again.`);
    await peer.close().catch(() => {});
    process.exit(1);
}

// --- the measurement ------------------------------------------------------------------------------

const priceKey = `app/oracle/price/${BTC}`;
const broadcastMs = [], settleMs = [], ageAtSettle = [];
let failures = 0;

console.log(`\nSubmitting ${SAMPLES} BTC/USD updates, ${INTERVAL / 1000}s apart. Each costs 0.03 TNK.\n`);
console.log('sample   broadcast   settled   price age when settled');

for (let i = 1; i <= SAMPLES; i++) {
    let update;
    try { update = await freshUpdate(); } catch (err) { console.log(`${String(i).padStart(6)}   fetch failed: ${err.message}`); failures++; continue; }

    const t0 = performance.now();
    let res;
    try {
        res = await peer.protocol.instance.tx({ command: `pyth ${update.hex}` });
    } catch (err) {
        console.log(`${String(i).padStart(6)}   submit failed: ${err.message}`);
        failures++;
        await new Promise((r) => setTimeout(r, INTERVAL));
        continue;
    }
    const t1 = performance.now();

    // Settled means: readable from the signed view, which is what every node agrees on.
    let settled = null;
    const deadline = Date.now() + TIMEOUT;
    while (Date.now() < deadline) {
        const stored = await peer.protocol.instance.getSigned(priceKey).catch(() => null);
        if (stored && Number(stored.publishTime) >= update.publishTime) { settled = performance.now(); break; }
        await new Promise((r) => setTimeout(r, 100));
    }

    if (settled === null) {
        console.log(`${String(i).padStart(6)}   ${secs(t1 - t0).padStart(9)}   timed out after ${TIMEOUT / 1000}s`);
        failures++;
    } else {
        broadcastMs.push(t1 - t0);
        settleMs.push(settled - t0);
        ageAtSettle.push(Math.floor(Date.now() / 1000) - update.publishTime);
        console.log(`${String(i).padStart(6)}   ${secs(t1 - t0).padStart(9)}   ${secs(settled - t0).padStart(7)}   ${ageAtSettle[ageAtSettle.length - 1]}s`);
    }
    if (i < SAMPLES) await new Promise((r) => setTimeout(r, INTERVAL));
}

if (settleMs.length) {
    const b = stat(broadcastMs), s = stat(settleMs), a = stat(ageAtSettle);
    console.log(`\n${settleMs.length} settled, ${failures} failed.\n`);
    console.log('                        median      p90      max');
    console.log(`broadcast returns   ${secs(b.median).padStart(10)} ${secs(b.p90).padStart(8)} ${secs(b.max).padStart(8)}`);
    console.log(`settled             ${secs(s.median).padStart(10)} ${secs(s.p90).padStart(8)} ${secs(s.max).padStart(8)}`);
    console.log(`price age at settle ${(a.median + 's').padStart(10)} ${(a.p90 + 's').padStart(8)} ${(a.max + 's').padStart(8)}`);
    console.log(`
TNK spent: about ${(settleMs.length * 0.03).toFixed(2)} TNK.

Read "price age at settle" against the 30-second staleness threshold: it is the real age of a price at
the moment the contract has agreed on it, fetch and verification included. If the worst case sits far
below 30 seconds, the threshold can come down, which narrows how far a price can drift before a fill.`);
} else {
    console.log('\nNothing settled. Check that the peer is a writer on the subnet and its MSB address holds TNK.');
}

await peer.close().catch(() => {});
await peer.store?.close?.().catch(() => {});
process.exit(0);
