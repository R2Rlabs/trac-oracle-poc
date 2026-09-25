// Deploys this oracle contract as a subnet on Trac and registers it with the MSB.
// Usage: node scripts/deploy-subnet.mjs [--env=mainnet] [--dry-run]
//
// Spends TNK from the wallet in stores/<env>/db/keypair.json (0.03 per transaction). The subnet
// bootstrap it prints is what the settlement harness and any other peer needs to join.
//
// A deployment is permanent: the subnet exists on Trac afterwards, deployed by this address.
import path from 'path';
import fs from 'fs/promises';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import { MainSettlementBus } from 'trac-msb/src/index.js';
import { createConfig as createMsbConfig, ENV as MSB_ENV } from 'trac-msb/src/config/env.js';
import { Peer, Wallet, createConfig as createPeerConfig, ENV as PEER_ENV } from 'trac-peer';
import { TerminalHandlers } from 'trac-peer/src/terminal/handlers.js';
import PythOracleProtocol from '../src/oracle-protocol.js';
import PythOracleContract from '../src/oracle-contract.js';

const args = Object.fromEntries(process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || '1']; }));

const envName = (args.env ?? 'mainnet').toUpperCase();
const DRY = args['dry-run'] === '1';
const STORES = 'stores/';
const CHANNEL = args.channel ?? 'halyard-oracle';

const log = async (line) => {
    console.log(line);
    try { await fs.appendFile('deploy.log', line + '\n'); } catch { /* best effort */ }
};

const msbConfig = createMsbConfig(MSB_ENV[envName], {
    storeName: 'latency-msb',
    storesDirectory: STORES,
    // The default is 9s. On the legacy protocol a validator sends no reply: the client waits for the tx
    // to show up in unsigned state, and a node that has just caught up needs longer than that.
    messageValidatorResponseTimeout: Number(args.timeout ?? 60_000),
});
const msbWallet = new PeerWallet({ networkPrefix: msbConfig.addressPrefix, derivationPath: msbConfig.derivationPath });
msbWallet.importFromFile(msbConfig.keyPairPath, b4a.alloc(0));

const msb = new MainSettlementBus(msbConfig, msbWallet);
await msb.ready();

const balanceOf = async () => {
    const entry = await msb.state.getNodeEntry(msbWallet.address);
    return entry?.balance ? BigInt('0x' + b4a.toString(entry.balance, 'hex')) : 0n;
};

const before = await balanceOf();
await log(`address: ${msbWallet.address}`);
await log(`balance: ${Number(before) / 1e18} TNK`);
if (before === 0n) { await log('Nothing to spend. Fund the address first.'); process.exit(1); }

// No bootstrap given, so the peer creates its own: that is the new subnet.
const peerStoreName = 'oracle-subnet';
const peerConfig = createPeerConfig(PEER_ENV[envName], {
    storesDirectory: STORES,
    storeName: peerStoreName,
    channel: CHANNEL,
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

const bootstrapHex = b4a.isBuffer(peer.config.bootstrap)
    ? b4a.toString(peer.config.bootstrap, 'hex')
    : String(peer.config.bootstrap ?? '');
await log(`subnet bootstrap: ${bootstrapHex}`);
await log(`subnet channel:   ${CHANNEL}`);
await log(`peer public key:  ${peerWallet.publicKey}`);
await log(`writer key:       ${peer.base?.local?.key ? b4a.toString(peer.base.local.key, 'hex') : '(unknown)'}`);

if (DRY) { await log('dry run: nothing broadcast.'); await peer.close().catch(() => {}); process.exit(0); }

// A broadcast goes to a connected validator. A node that has just started has none, and the send
// silently returns false, which is what the first two attempts hit.
const connectedValidators = () => {
    try {
        const cm = msb.network?.validatorMessageOrchestrator?.connectionManager;
        const list = cm?.connectedValidators?.();
        return Array.isArray(list) ? list.length : (cm?.pickRandomConnectedValidator?.() ? 1 : 0);
    } catch { return 0; }
};

// Wait until the node has actually caught up: a stale txv is rejected, and the deployment tx will not
// appear in unsigned state if we are not following it yet.
await log('\nWaiting for the node to catch up…');
let lastSigned = -1, stable = 0;
const syncBy = Date.now() + 180_000;
while (Date.now() < syncBy && stable < 3) {
    let signed = 0;
    try { signed = await msb.state.getSignedLength(); } catch { /* not ready */ }
    if (signed > 0 && signed === lastSigned) stable++; else stable = 0;
    if (signed !== lastSigned) await log(`  signed length ${signed}`);
    lastSigned = signed;
    await new Promise((r) => setTimeout(r, 5_000));
}
await log(`caught up at signed length ${lastSigned}`);

await log('\nWaiting for validator connections…');
const connectBy = Date.now() + 180_000;
let validators = connectedValidators();
while (validators === 0 && Date.now() < connectBy) {
    await new Promise((r) => setTimeout(r, 5_000));
    validators = connectedValidators();
}
await log(`connected validators: ${validators}`);
if (validators === 0) {
    await log('No validator connections after 3 minutes, so a broadcast would fail silently. Stopping.');
    await peer.close().catch(() => {});
    process.exit(1);
}

// Validators answer with a numeric result code, but the orchestrator swallows it and returns a bare
// false. Wrap the sender so the real reason reaches the log.
try {
    const cm = msb.network?.validatorMessageOrchestrator?.connectionManager;
    if (cm && typeof cm.sendSingleMessage === 'function') {
        const original = cm.sendSingleMessage.bind(cm);
        cm.sendSingleMessage = async (message, key) => {
            const code = await original(message, key);
            await log(`  validator result code: ${code}`);
            return code;
        };
    } else {
        await log('  (could not instrument the sender; result codes will not be visible)');
    }
} catch (err) {
    await log(`  instrumenting the sender failed: ${err.message}`);
}

await log('\nBroadcasting the deployment…');
let deployed = false;
for (let attempt = 1; attempt <= 3 && !deployed; attempt++) {
    try {
        const handlers = new TerminalHandlers(peer);
        const payload = await handlers.deploySubnet('/deploy_subnet');
        await log(`deployment tx: ${payload?.bdo?.tx ?? '(none returned)'}`);
        deployed = true;
    } catch (err) {
        await log(`attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 10_000));
    }
}
if (!deployed) { await peer.close().catch(() => {}); process.exit(1); }

// Wait for the MSB to confirm it, and report what it cost.
const deadline = Date.now() + 180_000;
let registered = false;
while (Date.now() < deadline) {
    try {
        const entry = await msb.state.getRegisteredBootstrapEntry(bootstrapHex);
        if (entry) { registered = true; break; }
    } catch { /* not there yet */ }
    await new Promise((r) => setTimeout(r, 5_000));
}

const after = await balanceOf();
await log(`\nregistered on the MSB: ${registered ? 'yes' : 'not yet within 3 minutes'}`);
await log(`spent: ${Number(before - after) / 1e18} TNK (balance now ${Number(after) / 1e18})`);
await log(`\nRun the measurement with:\n  node scripts/measure-settlement.mjs --subnet-bootstrap=${bootstrapHex} --subnet-channel=${CHANNEL}`);

await peer.close().catch(() => {});
process.exit(registered ? 0 : 1);
