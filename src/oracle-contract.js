import { Contract } from 'trac-peer';
import { verifyPythUpdate } from './pyth-verifier.js';
import { TRUST_ANCHOR } from './trust-anchor.js';

// Feeds this app tracks (Pyth feed id -> symbol). Updates may carry other feeds; those are ignored,
// which keeps contract storage bounded no matter what a submitter bundles in.
export const FEEDS = {
    e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43: 'BTC/USD',
    ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace: 'ETH/USD',
    c9d8b075a5c69303365ae23633d4e085199bf5c520a3b90fed1322a0342ffc33: 'WBTC/USD',
    '23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744': 'SUI/USD',
    '44465e17d2e9d390e70c999d5a11fda4f092847fcd2e3e5aa089d96c98a30e67': 'XAUT/USD',
};

export const priceKey = (feedId) => `app/oracle/price/${feedId}`;

/**
 * Permissionless price oracle for a Trac subnet.
 *
 * Anyone can submit a Pyth update. Every subnet node verifies the signatures and Merkle proof
 * itself against the pinned trust anchor, so a price is stored only if Pyth's signers signed it.
 * The contract registers no Features, so the subnet admin has no way to write a price.
 */
class PythOracleContract extends Contract {
    constructor(protocol, config) {
        super(protocol, config);
        this.addSchema('submitPriceUpdate', {
            value: {
                $$strict: true,
                $$type: 'object',
                update: { type: 'string', min: 16, max: 16_000, hex: true },
            },
        });
    }

    async submitPriceUpdate() {
        const result = verifyPythUpdate(this.value.update, TRUST_ANCHOR);
        // A failed assert is the framework's rejection path: the op is dropped and the
        // AssertionError is returned to the caller instead of crashing the node.
        this.assert(result.ok, result.reason);

        const updated = [];
        const skipped = [];
        for (const p of result.prices) {
            const symbol = FEEDS[p.feedId];
            if (symbol === undefined) continue;
            const current = await this.get(priceKey(p.feedId));
            // Prices only move forward in time, so an old signed update can't be replayed
            // to roll the price back (for example, to trigger a liquidation).
            if (current !== null && BigInt(current.publishTime) >= p.publishTime) {
                skipped.push(symbol);
                continue;
            }
            await this.put(priceKey(p.feedId), {
                symbol,
                price: p.price.toString(),
                conf: p.conf.toString(),
                expo: p.expo,
                publishTime: p.publishTime.toString(),
                emaPrice: p.emaPrice.toString(),
                emaConf: p.emaConf.toString(),
                slot: result.slot.toString(),
                vaaHash: result.vaa.hash,
                submittedBy: this.address,
                tx: this.tx,
            });
            updated.push(symbol);
        }
        this.assert(updated.length > 0, `no newer prices for tracked feeds (stale: ${skipped.join(', ') || 'none'})`);
        return { updated, skipped };
    }
}

export default PythOracleContract;
