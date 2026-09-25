// Is the subnet registered on the MSB, and what did it cost?
// Usage: node scripts/check-subnet.mjs [--bootstrap=<hex32>] [--env=mainnet]
import b4a from 'b4a';
import fs from 'fs/promises';
import PeerWallet from 'trac-wallet';
import { MainSettlementBus } from 'trac-msb/src/index.js';
import { createConfig as createMsbConfig, ENV as MSB_ENV } from 'trac-msb/src/config/env.js';

const args = Object.fromEntries(process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || '1']; }));

const envName = (args.env ?? 'mainnet').toUpperCase();
const bootstrap = (args.bootstrap ?? '464c137880ad579f1c98e248fd1662fe8a37ab40aecbdf0895a70c77cb56aba0').toLowerCase();

const config = createMsbConfig(MSB_ENV[envName], { storeName: 'latency-msb', storesDirectory: 'stores/' });
const wallet = new PeerWallet({ networkPrefix: config.addressPrefix, derivationPath: config.derivationPath });
wallet.importFromFile(config.keyPairPath, b4a.alloc(0));

const msb = new MainSettlementBus(config, wallet);
await msb.ready();

const out = [];
const say = (l) => { console.log(l); out.push(l); };

// Give the node a moment to catch up before asking.
await new Promise((r) => setTimeout(r, 20_000));

const entry = await msb.state.getNodeEntry(wallet.address).catch(() => null);
const balance = entry?.balance ? BigInt('0x' + b4a.toString(entry.balance, 'hex')) : 0n;
say(`address:  ${wallet.address}`);
say(`balance:  ${Number(balance) / 1e18} TNK`);

let registered = null;
try { registered = await msb.state.getRegisteredBootstrapEntry(bootstrap); } catch (err) { say(`lookup failed: ${err.message}`); }
say(`bootstrap ${bootstrap}`);
say(`registered: ${registered ? 'YES' : 'no'}`);
if (registered) {
    const deployer = b4a.toString(registered.slice(32), 'ascii');
    say(`deployed by: ${deployer}`);
    say(`deployed by us: ${deployer === wallet.address ? 'yes' : 'no'}`);
}

await fs.writeFile('subnet-status.log', out.join('\n') + '\n').catch(() => {});
process.exit(registered ? 0 : 1);
