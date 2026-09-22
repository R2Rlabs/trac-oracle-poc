import { Protocol } from 'trac-peer';
import { FEEDS, priceKey } from './oracle-contract.js';

class PythOracleProtocol extends Protocol {
    // trac-peer's default cap is 4,096 bytes per tx, which fits roughly 5 feeds of a hex-encoded
    // Pyth update. 8 KB allows about 10. The update itself is never sent to MSB (only its hash is),
    // so this only affects subnet replication.
    txMaxBytes() {
        return 8_192;
    }

    // CLI: /tx --command "pyth <hex update>"
    mapTxCommand(command) {
        if (typeof command !== 'string') return null;
        const raw = command.trim();
        if (raw.startsWith('pyth ')) {
            return { type: 'submitPriceUpdate', value: { update: raw.slice(5).trim().replace(/^0x/, '') } };
        }
        return null;
    }

    // Read-only RPC methods (exposed through the peer's /v1/contract/schema discovery).
    async extendApi() {
        const protocol = this;
        this.api.getPrice = async function (feedIdOrSymbol) {
            const feedId = Object.keys(FEEDS).find((id) => id === feedIdOrSymbol || FEEDS[id] === feedIdOrSymbol);
            if (feedId === undefined) return null;
            return await protocol.getSigned(priceKey(feedId));
        };
        this.api.listFeeds = function () {
            return FEEDS;
        };
    }
}

export default PythOracleProtocol;
