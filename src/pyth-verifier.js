// Verifies Pyth price updates ("accumulator updates", PNAU) against Wormhole guardian signatures.
//
// Chain of trust, with no Trac admin anywhere in it:
//   Pinned signer set --(quorum of secp256k1 signatures)--> VAA from Pyth's accumulator emitter
//   VAA payload --(contains)--> Merkle root of every price published in that Pythnet slot
//   Merkle proof --(keccak160 path)--> one price feed message (id, price, conf, expo, publish time)
//
// Everything here is a pure function of its inputs: no clock, no network, no randomness,
// so every Trac subnet node reaches the same verdict. It never throws: malformed input
// returns { ok: false, reason } so the contract can reject it deterministically.
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

// The trust anchor (which signers, what quorum, which emitters) is passed in by the caller,
// see src/trust-anchor.js:
//   { guardianSets: { [index]: { quorum, keys: [ethAddressHex] } }, dataSources: [{ chain, emitter }] }

const PNAU_MAGIC = '504e4155'; // "PNAU"
const AUWV_MAGIC = '41555756'; // "AUWV"
const UPDATE_TYPE_WORMHOLE_MERKLE = 0;
const MESSAGE_TYPE_PRICE_FEED = 0;
const SECP256K1_N = secp256k1.CURVE.n;

const fail = (reason) => ({ ok: false, reason });

class Reader {
    constructor(bytes) {
        this.b = bytes;
        this.o = 0;
        this.overrun = false;
    }
    take(n) {
        if (this.overrun || this.o + n > this.b.length) {
            this.overrun = true;
            return new Uint8Array(n);
        }
        const out = this.b.subarray(this.o, this.o + n);
        this.o += n;
        return out;
    }
    u8() { return this.take(1)[0]; }
    u16() { const b = this.take(2); return (b[0] << 8) | b[1]; }
    u32() { const b = this.take(4); return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]; }
    u64() { return BigInt('0x' + bytesToHex(this.take(8))); }
    i64() { return BigInt.asIntN(64, this.u64()); }
    i32() { return this.u32() | 0; }
    rest() { return this.take(this.b.length - this.o); }
    get done() { return this.o === this.b.length; }
}

const keccak160 = (bytes) => keccak_256(bytes).subarray(0, 20);

function compareBytes(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}

// Ethereum-style address (hex, no 0x) that produced a signature over `digest`,
// or null if the signature is malformed.
function recoverAddress(digest, r, s, v) {
    if (v > 1) return null;
    const rn = BigInt('0x' + bytesToHex(r));
    const sn = BigInt('0x' + bytesToHex(s));
    if (rn === 0n || sn === 0n || rn >= SECP256K1_N || sn >= SECP256K1_N) return null;
    try {
        // A try/catch around a pure function is still deterministic: the same bytes
        // fail the same way on every node.
        const sig = new secp256k1.Signature(rn, sn).addRecoveryBit(v);
        const pub = sig.recoverPublicKey(digest).toRawBytes(false); // 0x04 || X || Y
        return bytesToHex(keccak_256(pub.subarray(1)).subarray(12));
    } catch {
        return null;
    }
}

/**
 * Parses a Wormhole-format VAA and checks that a quorum of the pinned guardian set signed it.
 * The quorum comes from the trust anchor: Wormhole mainnet uses floor(2n/3) + 1, Pyth's current
 * receiver uses floor(n/2) + 1.
 */
export function verifyVaa(vaaBytes, guardianSets) {
    const r = new Reader(vaaBytes);
    const version = r.u8();
    const guardianSetIndex = r.u32();
    const sigCount = r.u8();
    const sigs = [];
    for (let i = 0; i < sigCount; i++) {
        sigs.push({ index: r.u8(), r: r.take(32), s: r.take(32), v: r.u8() });
    }
    if (r.overrun) return fail('VAA truncated');
    if (version !== 1) return fail(`unsupported VAA version ${version}`);

    const set = Object.hasOwn(guardianSets, guardianSetIndex) ? guardianSets[guardianSetIndex] : null;
    if (!set) return fail(`unknown guardian set ${guardianSetIndex}`);
    const guardians = set.keys;
    const quorum = set.quorum;
    if (!Number.isInteger(quorum) || quorum < 1 || quorum > guardians.length) return fail('invalid quorum in trust anchor');

    const body = r.rest();
    const digest = keccak_256(keccak_256(body));

    let lastIndex = -1;
    let valid = 0;
    for (const sig of sigs) {
        // Ascending, unique guardian indices: stops one guardian's signature being counted twice.
        if (sig.index <= lastIndex) return fail('guardian signatures not strictly ascending');
        lastIndex = sig.index;
        if (sig.index >= guardians.length) return fail(`guardian index ${sig.index} out of range`);
        const signer = recoverAddress(digest, sig.r, sig.s, sig.v);
        if (signer !== guardians[sig.index].toLowerCase()) {
            return fail(`bad signature from guardian ${sig.index}`);
        }
        valid++;
    }
    if (valid < quorum) return fail(`only ${valid} guardian signatures, need ${quorum}`);

    const b = new Reader(body);
    const vaa = {
        guardianSetIndex,
        signatures: valid,
        quorum,
        timestamp: b.u32(),
        nonce: b.u32(),
        emitterChain: b.u16(),
        emitterAddress: bytesToHex(b.take(32)),
        sequence: b.u64(),
        consistency: b.u8(),
        payload: b.rest(),
        hash: bytesToHex(digest),
    };
    if (b.overrun) return fail('VAA body truncated');
    return { ok: true, vaa };
}

function parsePriceMessage(msg) {
    const r = new Reader(msg);
    const type = r.u8();
    if (type !== MESSAGE_TYPE_PRICE_FEED) return null; // e.g. TWAP messages: skip, don't fail
    const m = {
        feedId: bytesToHex(r.take(32)),
        price: r.i64(),
        conf: r.u64(),
        expo: r.i32(),
        publishTime: r.i64(),
        prevPublishTime: r.i64(),
        emaPrice: r.i64(),
        emaConf: r.u64(),
    };
    // Newer message versions may append fields, so only require the known prefix.
    return r.overrun ? null : m;
}

/**
 * Verifies a full Pyth accumulator update (hex string or bytes).
 * Returns { ok: true, slot, vaa, prices: [...] } or { ok: false, reason }.
 */
export function verifyPythUpdate(update, trust) {
    let bytes;
    if (typeof update === 'string') {
        const hex = update.startsWith('0x') ? update.slice(2) : update;
        if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return fail('update is not hex');
        bytes = hexToBytes(hex);
    } else if (update instanceof Uint8Array) {
        bytes = update;
    } else {
        return fail('update must be hex or bytes');
    }

    const r = new Reader(bytes);
    if (bytesToHex(r.take(4)) !== PNAU_MAGIC) return fail('not a Pyth accumulator update (bad magic)');
    const major = r.u8();
    r.u8(); // minor version: forward compatible
    r.take(r.u8()); // trailing header, reserved for future use
    if (major !== 1) return fail(`unsupported update version ${major}`);
    if (r.u8() !== UPDATE_TYPE_WORMHOLE_MERKLE) return fail('unsupported update type');
    const vaaBytes = r.take(r.u16());
    if (r.overrun) return fail('update truncated');

    const v = verifyVaa(vaaBytes, trust.guardianSets);
    if (!v.ok) return v;
    const { vaa } = v;
    const trustedEmitter = trust.dataSources.some(
        (d) => d.chain === vaa.emitterChain && d.emitter.toLowerCase() === vaa.emitterAddress
    );
    if (!trustedEmitter) return fail('VAA is not from a trusted Pyth emitter');

    const p = new Reader(vaa.payload);
    if (bytesToHex(p.take(4)) !== AUWV_MAGIC) return fail('VAA payload is not a Merkle root (bad magic)');
    if (p.u8() !== UPDATE_TYPE_WORMHOLE_MERKLE) return fail('unsupported VAA payload type');
    const slot = p.u64();
    p.u32(); // ring size
    const root = p.take(20);
    if (p.overrun) return fail('VAA payload truncated');

    const prices = [];
    const count = r.u8();
    if (r.overrun || count === 0) return fail('update has no price messages');
    for (let i = 0; i < count; i++) {
        const message = r.take(r.u16());
        const proof = [];
        const depth = r.u8();
        for (let j = 0; j < depth; j++) proof.push(r.take(20));
        if (r.overrun) return fail('update truncated');

        // Leaf and inner nodes are domain separated (0x00 / 0x01); siblings are sorted.
        let node = keccak160(concatBytes(new Uint8Array([0]), message));
        for (const sibling of proof) {
            const [a, b] = compareBytes(node, sibling) <= 0 ? [node, sibling] : [sibling, node];
            node = keccak160(concatBytes(new Uint8Array([1]), a, b));
        }
        if (compareBytes(node, root) !== 0) return fail(`Merkle proof ${i} does not match signed root`);

        const price = parsePriceMessage(message);
        if (price) prices.push(price);
    }
    if (!r.done) return fail('trailing bytes after updates');

    return { ok: true, slot, vaa, prices };
}
