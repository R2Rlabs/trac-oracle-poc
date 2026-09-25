// Prints the MSB wallet this repo's scripts use: its address, and what it holds.
// Usage: node scripts/wallet.mjs [--env=mainnet|testnet1|development]
//
// Creates the wallet on first run. Everything the settlement harness does costs TNK from this address,
// at 0.03 TNK per transaction, so this is the thing to fund.
import path from 'path';
import fs from 'fs/promises';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import { MainSettlementBus } from 'trac-msb/src/index.js';
import { createConfig as createMsbConfig, ENV as MSB_ENV } from 'trac-msb/src/config/env.js';

const args = Object.fromEntries(process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || '1']; }));

const envName = (args.env ?? process.env.TRAC_ENV ?? 'mainnet').toUpperCase();
if (!MSB_ENV[envName]) { console.error(`Unknown --env ${envName}.`); process.exit(1); }

const config = createMsbConfig(MSB_ENV[envName], {
    storeName: args['msb-store-name'] ?? 'latency-msb',
    storesDirectory: args['stores-directory'] ?? 'stores/',
});

const wallet = new PeerWallet({ networkPrefix: config.addressPrefix, derivationPath: config.derivationPath });
let created = false;
try {
    await fs.access(config.keyPairPath);
    wallet.importFromFile(config.keyPairPath, b4a.alloc(0));
} catch {
    await fs.mkdir(path.dirname(config.keyPairPath), { recursive: true });
    await wallet.generateKeyPair();
    await wallet.exportToFile(config.keyPairPath, b4a.alloc(0));
    created = true;
}

console.log(`\nnetwork:  ${envName.toLowerCase()}`);
console.log(`address:  ${wallet.address}`);
console.log(`key file: ${config.keyPairPath}${created ? '  (just created: back it up)' : ''}`);

// The balance needs a live MSB node, which takes a moment to find peers.
const msb = new MainSettlementBus(config, wallet);
const timeout = Number(args.timeout ?? 120_000);
const ready = msb.ready().then(() => 'ready');
const raced = await Promise.race([ready, new Promise((r) => setTimeout(() => r('timeout'), timeout))]);

if (raced === 'timeout') {
    console.log(`\nCouldn't reach the ${envName.toLowerCase()} MSB within ${timeout / 1000}s, so no balance to show.`);
    process.exit(0);
}

try {
    const entry = await msb.state.getNodeEntry(wallet.address);
    const balance = entry?.balance ? BigInt('0x' + b4a.toString(entry.balance, 'hex')) : 0n;
    console.log(`balance:  ${balance} (raw units)`);
    if (balance === 0n) console.log(`\nSend TNK to the address above before running the settlement harness.`);
} catch (err) {
    console.log(`\nCouldn't read the balance: ${err.message}`);
}
process.exit(0);
