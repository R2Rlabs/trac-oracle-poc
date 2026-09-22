// Starts a real trac-peer Peer running the oracle app, against an in-process MSB stub.
// The stub is adapted from trac-peer's own tests/acceptance/rpc.test.js: it reports every account
// as funded and accepts every broadcast, so what's under test is the subnet side (contract execution).
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import { safeEncodeApplyOperation } from 'trac-msb/src/utils/protobuf/operationHelpers.js';
import { OperationType } from 'trac-msb/src/utils/constants.js';
import { Peer, Wallet, createConfig, ENV } from 'trac-peer';
import PythOracleProtocol from '../../src/oracle-protocol.js';
import PythOracleContract from '../../src/oracle-contract.js';

function createMsbStub() {
    const fee = b4a.alloc(16);
    fee[15] = 1;
    const funded = b4a.alloc(16).fill(0xff);
    const bootstrap = b4a.alloc(32).fill(7);
    const txv = b4a.alloc(32).fill(1);
    const dummyAddress = PeerWallet.encodeBech32mSafe('trac', b4a.alloc(32).fill(2));
    const addressLength = dummyAddress.length;
    const deployedByTx = b4a.alloc(32).fill(3);
    const txStore = new Map();
    return {
        async ready() {},
        config: { bootstrap, networkId: 918, addressPrefix: 'trac', addressLength, channel: b4a.from('test', 'utf8') },
        bootstrap,
        state: {
            getIndexerSequenceState: async () => txv,
            getSignedLength: () => 0,
            getFee: () => fee,
            getNodeEntryUnsigned: async () => ({ balance: funded }),
            getNodeEntry: async () => ({ balance: funded }),
            get: async (key) => txStore.get(key) ?? null,
            getRegisteredBootstrapEntry: async (bootstrapHex) => {
                if (typeof bootstrapHex !== 'string' || !/^[0-9a-f]{64}$/i.test(bootstrapHex)) return null;
                const entry = b4a.alloc(32 + addressLength);
                deployedByTx.copy(entry, 0);
                b4a.from(dummyAddress, 'ascii').copy(entry, 32);
                txStore.set(deployedByTx.toString('hex'), safeEncodeApplyOperation({
                    type: OperationType.BOOTSTRAP_DEPLOYMENT,
                    address: b4a.from(dummyAddress, 'ascii'),
                    bdo: { tx: deployedByTx, txv, bs: b4a.from(bootstrapHex, 'hex'), ic: b4a.alloc(32), in: b4a.alloc(32), is: b4a.alloc(64) },
                }));
                return entry;
            },
            base: { view: { checkout() { return { async get() { return null; }, async close() {} }; } } },
        },
        network: {},
        broadcastTransactionCommand: async (payload) => ({ message: 'ok', tx: payload?.txo?.tx ?? null }),
    };
}

export async function withOraclePeer(fn) {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trac-oracle-poc-'));
    const storesDirectory = tmpRoot + path.sep;
    const storeName = 'peer';
    const wallet = new Wallet();
    await wallet.generateKeyPair();
    const keypairPath = path.join(storesDirectory, storeName, 'db', 'keypair.json');
    await fs.mkdir(path.dirname(keypairPath), { recursive: true });
    await wallet.exportToFile(keypairPath, b4a.alloc(0));

    const peer = new Peer({
        config: createConfig(ENV.DEVELOPMENT, { storesDirectory, storeName }),
        wallet,
        protocol: PythOracleProtocol,
        contract: PythOracleContract,
        msb: createMsbStub(),
    });
    try {
        await peer.ready();
        return await fn(peer);
    } finally {
        try { await peer.close(); } catch {}
        try { await peer.store.close(); } catch {}
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
}

// Minimal persistent storage with the same get/put/del shape the contract sees during apply.
export function memoryStorage() {
    const values = new Map();
    return {
        values,
        async get(key) { return values.has(key) ? { value: values.get(key) } : null; },
        async put(key, value) { values.set(key, value); },
        async del(key) { values.delete(key); },
    };
}
