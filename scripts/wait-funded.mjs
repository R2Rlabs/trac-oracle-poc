// Waits for the local MSB node to sync, then reports the wallet balance.
// A fresh node starts with nothing, so a zero balance before sync means nothing at all.
// Usage: node scripts/wait-funded.mjs [--minutes=10] [--env=mainnet]
import fs from 'fs/promises';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import { MainSettlementBus } from 'trac-msb/src/index.js';
import { createConfig as createMsbConfig, ENV as MSB_ENV } from 'trac-msb/src/config/env.js';

const args = Object.fromEntries(process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || '1']; }));

const envName = (args.env ?? 'mainnet').toUpperCase();
// Under the Pear runtime stdout does not come back to the launcher, so write progress to a file too.
const LOGFILE = args.log ?? 'sync-status.log';
const say = async (line) => {
    console.log(line);
    try { await fs.appendFile(LOGFILE, line + '\n'); } catch { /* logging is best effort */ }
};
const MINUTES = Number(args.minutes ?? 10);
const config = createMsbConfig(MSB_ENV[envName], { storeName: 'latency-msb', storesDirectory: 'stores/' });

const wallet = new PeerWallet({ networkPrefix: config.addressPrefix, derivationPath: config.derivationPath });
await fs.access(config.keyPairPath);
wallet.importFromFile(config.keyPairPath, b4a.alloc(0));

const msb = new MainSettlementBus(config, wallet);
await msb.ready();

const readBalance = async (confirmed) => {
    try {
        const entry = confirmed
            ? await msb.state.getNodeEntry(wallet.address)
            : await msb.state.getNodeEntryUnsigned(wallet.address);
        if (!entry?.balance) return 0n;
        return BigInt('0x' + b4a.toString(entry.balance, 'hex'));
    } catch { return null; }
};

const safe = async (label, fn) => {
    try { return await fn(); } catch (err) { return `error: ${err.message}`; }
};

const deadline = Date.now() + MINUTES * 60_000;
while (Date.now() < deadline) {
    const signed = await safe('signed', () => msb.state.getSignedLength());
    const unsigned = await safe('unsigned', () => msb.state.getUnsignedLength?.());
    const confirmed = await safe('confirmed', () => readBalance(true));
    const pending = await safe('unconfirmed', () => readBalance(false));
    const left = Math.round((deadline - Date.now()) / 1000);
    await say(`STATUS signed ${signed} | unsigned ${unsigned} | confirmed ${confirmed} | unconfirmed ${pending} | ${left}s left`);
    if (typeof confirmed === 'bigint' && confirmed > 0n) {
        await say(`FUNDED ${confirmed} raw units, which is ${Number(confirmed) / 1e18} TNK.`);
        process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 20_000));
}
await say('TIMEOUT no confirmed balance yet.');
process.exit(1);
