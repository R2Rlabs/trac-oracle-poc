// Builds well-formed Pyth accumulator updates signed by keys the test controls. Used to model an
// attacker who can produce perfectly formatted updates but doesn't hold Pyth's signer keys.
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

const u8 = (n) => new Uint8Array([n]);
const be = (n, bytes) => hexToBytes(BigInt.asUintN(bytes * 8, BigInt(n)).toString(16).padStart(bytes * 2, '0'));
const keccak160 = (b) => keccak_256(b).subarray(0, 20);
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const hashPair = (a, b) => keccak160(concatBytes(u8(1), ...(cmp(a, b) <= 0 ? [a, b] : [b, a])));

export function makeSigner() {
    const priv = secp256k1.utils.randomPrivateKey();
    const pub = secp256k1.getPublicKey(priv, false);
    return { priv, address: bytesToHex(keccak_256(pub.subarray(1)).subarray(12)) };
}

export function priceMessage({ feedId, price, conf = 1n, expo = -8, publishTime, emaPrice = price, emaConf = conf }) {
    return concatBytes(
        u8(0), hexToBytes(feedId), be(price, 8), be(conf, 8), be(expo, 4),
        be(publishTime, 8), be(BigInt(publishTime) - 1n, 8), be(emaPrice, 8), be(emaConf, 8)
    );
}

// Merkle tree matching Pyth's: leaves keccak160(0x00 || msg), nodes keccak160(0x01 || sorted pair).
function merkle(messages) {
    let level = messages.map((m) => keccak160(concatBytes(u8(0), m)));
    const proofs = messages.map(() => []);
    let positions = messages.map((_, i) => i);
    while (level.length > 1) {
        if (level.length % 2 === 1) level.push(level[level.length - 1]);
        positions.forEach((pos, i) => proofs[i].push(level[pos ^ 1]));
        const next = [];
        for (let i = 0; i < level.length; i += 2) next.push(hashPair(level[i], level[i + 1]));
        level = next;
        positions = positions.map((p) => p >> 1);
    }
    return { root: level[0], proofs };
}

export function buildUpdate({ signers, guardianSetIndex = 1, emitterChain = 26, emitter, slot = 1n, prices }) {
    const messages = prices.map(priceMessage);
    const { root, proofs } = merkle(messages);
    const payload = concatBytes(hexToBytes('41555756'), u8(0), be(slot, 8), be(0, 4), root);
    const body = concatBytes(be(0, 4), be(0, 4), be(emitterChain, 2), hexToBytes(emitter), be(slot, 8), u8(0), payload);
    const digest = keccak_256(keccak_256(body));
    const sigs = signers.map((s, index) => {
        const sig = secp256k1.sign(digest, s.priv, { lowS: true });
        return concatBytes(u8(index), be(sig.r, 32), be(sig.s, 32), u8(sig.recovery));
    });
    const vaa = concatBytes(u8(1), be(guardianSetIndex, 4), u8(sigs.length), ...sigs, body);
    const updates = messages.map((m, i) => concatBytes(be(m.length, 2), m, u8(proofs[i].length), ...proofs[i]));
    return bytesToHex(concatBytes(
        hexToBytes('504e4155'), u8(1), u8(0), u8(0), u8(0), be(vaa.length, 2), vaa, u8(messages.length), ...updates
    ));
}
