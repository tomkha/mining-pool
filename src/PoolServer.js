const https = require('https');
const WebSocket = require('ws');
const fs = require('fs');

const Nimiq = require('@nimiq/core');

const PoolAgent = require('./PoolAgent.js');

class PoolServer extends Nimiq.Observable {
    /**
     * @param {Nimiq.FullConsensus} consensus
     * @param {PoolConfig} config
     * @param {number} port
     * @param {string} sslKeyPath
     * @param {string} sslCertPath
     * @param {{enabled: boolean, port: number, address: string, addresses: Array.<string>, header: string, checkSource: boolean, acceptHeader: boolean}} reverseProxy
     */
    constructor(consensus, config, port, sslKeyPath, sslCertPath, reverseProxy) {
        super();

        /** @type {Nimiq.FullConsensus} */
        this._consensus = consensus;

        /** @type {string} */
        this.name = config.name;

        /** @type {Nimiq.Address} */
        this.poolAddress = Nimiq.Address.fromUserFriendlyAddress(config.address);

        /** @type {PoolConfig} */
        this._config = config;

        /** @type {number} */
        this.port = port;

        /** @type {string} */
        this._sslKeyPath = sslKeyPath;

        /** @type {string} */
        this._sslCertPath = sslCertPath;

        /** @type {{enabled: boolean, port: number, address: string, addresses: Array.<string>, header: string, checkSource: boolean, acceptHeader: boolean}} */
        this._reverseProxy = reverseProxy;

        /** @type {Nimiq.Miner} */
        this._miner = new Nimiq.Miner(consensus.blockchain, consensus.blockchain.accounts, consensus.mempool, consensus.network.time, this.poolAddress);

        /** @type {Set.<PoolAgent>} */
        this._agents = new Set();

        /** @type {Nimiq.HashMap.<string, Nimiq.HashMap.<string, Array.<Hash>>>} */
        this._shares = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Nimiq.NetAddress, number>} */
        this._connectionsInTimePerIPv4 = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Uint8Array, number>} */
        this._connectionsInTimePerIPv6 = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Nimiq.NetAddress, number>} */
        this._connectionsPerIPv4 = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Uint8Array, number>} */
        this._connectionsPerIPv6 = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Nimiq.NetAddress, number>} */
        this._bannedIPv4IPs = new Nimiq.HashMap();

        /** @type {Nimiq.HashMap.<Uint8Array, number>} */
        this._bannedIPv6IPs = new Nimiq.HashMap();

        /** @type {number} */
        this._numBlocksMined = 0;

        /** @type {Nimiq.BigNumber} */
        this._totalShareDifficulty = new Nimiq.BigNumber(0);

        /** @type {number} */
        this._lastShareDifficulty = 0;

        /** @type {number[]} */
        this._hashrates = [];

        /** @type {number} */
        this._averageHashrate = 0;

        /** @type {boolean} */
        this._started = false;

        setInterval(() => {
            this._connectionsInTimePerIPv4 = new Nimiq.HashMap();
            this._connectionsInTimePerIPv6 = new Nimiq.HashMap();
        }, this.config.maxConnTimeUnit);

        setInterval(() => this._checkUnbanIps(), PoolServer.UNBAN_IPS_INTERVAL);

        setInterval(() => this._calculateHashrate(), PoolServer.HASHRATE_INTERVAL);

        this.consensus.on('established', () => this.start());
    }

    async start() {
        if (this._started) return;
        this._started = true;

        this._currentLightHead = this.consensus.blockchain.head.toLight();
        await this._updateTransactions();

        this._wss = PoolServer.createServer(this.port, this._sslKeyPath, this._sslCertPath);
        this._wss.on('connection', (ws, req) => this._onConnection(ws, req));

        this.consensus.blockchain.on('head-changed', (head) => {
            this._announceHeadToNano(head);
            this._removeOldShares(head.header.prevHash);
        });
    }

    static createServer(port, sslKeyPath, sslCertPath) {
        const sslOptions = {
            key: fs.readFileSync(sslKeyPath),
            cert: fs.readFileSync(sslCertPath)
        };
        const httpsServer = https.createServer(sslOptions, (req, res) => {
            res.writeHead(200);
            res.end('Nimiq Micro Pool Server\n');
        }).listen(port);

        // We have to access socket.remoteAddress here because otherwise req.connection.remoteAddress won't be set in the WebSocket's 'connection' event (yay)
        httpsServer.on('secureConnection', socket => socket.remoteAddress);

        Nimiq.Log.i(PoolServer, "Started server on port " + port);
        return new WebSocket.Server({server: httpsServer});
    }

    stop() {
        if (this._wss) {
            this._wss.close();
        }
    }

    /**
     * @param {WebSocket} ws
     * @param {http.IncomingMessage} req
     * @private
     */
    _onConnection(ws, req) {
        try {
            let netAddress = Nimiq.NetAddress.fromIP(req.connection.remoteAddress);
            if (this._reverseProxy.enabled || this._reverseProxy.checkSource) {
                let addresses = this._reverseProxy.addresses;
                if (!addresses) addresses = [this._reverseProxy.address];
                let matches = false;
                for (const address of addresses) {
                    let [ip, mask] = address.split('/');
                    if (mask) {
                        matches = Nimiq.NetAddress.fromIP(ip).subnet(mask).equals(netAddress.subnet(mask))
                    } else {
                        matches = Nimiq.NetAddress.fromIP(ip).equals(netAddress);
                    }
                    if (matches) break;
                }
                if (!matches) {
                    Nimiq.Log.e(PoolServer, `Received connection from ${netAddress.toString()} when all connections were expected from the reverse proxy: closing the connection`);
                    ws.close();
                    return;
                }
            }
            if (this._reverseProxy.enabled || this._reverseProxy.acceptHeader) {
                const reverseProxyHeader = this._reverseProxy.header;
                if (req.headers[reverseProxyHeader]) {
                    netAddress = Nimiq.NetAddress.fromIP(req.headers[reverseProxyHeader].split(/\s*,\s*/)[0]);
                } else if (this._reverseProxy.enabled) {
                    Nimiq.Log.i(PoolServer, `Expected header '${reverseProxyHeader}' to contain the real IP from the connecting client: closing the connection`);
                    ws.close();
                    return;
                } else {
                    Nimiq.Log.w(PoolServer, `Expected header '${reverseProxyHeader}' to contain the real IP from the connecting client`);
                }
            }
            if (this._isIpBanned(netAddress)) {
                Nimiq.Log.i(PoolServer, `[${netAddress}] Banned IP tried to connect`);
                ws.close();
            } else if (this._newIpConnTooMany(netAddress))  {
                Nimiq.Log.i(PoolServer, `[${netAddress}] Rejecting connection from IP having established too many connections (lately)`);
                ws.send(JSON.stringify({ message: PoolAgent.MESSAGE_ERROR, reason: 'too many consecutive or total connections per IP' }));
                ws.close();
            } else {
                const agent = new PoolAgent(this, ws, netAddress);
                agent.on('share', (header, difficulty) => this._onShare(header, difficulty));
                agent.on('block', (header) => this._onBlock(header));
                this._agents.add(agent);
            }
        } catch (e) {
            Nimiq.Log.e(PoolServer, e);
            ws.close();
        }
    }

    /**
     * @param {BlockHeader} header
     * @param {BigNumber} difficulty
     * @private
     */
    _onShare(header, difficulty) {
        this._totalShareDifficulty = this._totalShareDifficulty.plus(difficulty);
    }

    /**
     * @param {BlockHeader} header
     * @private
     */
    _onBlock(header) {
        this._numBlocksMined++;
    }

    /**
     * @param {PoolAgent} agent
     */
    requestCurrentHead(agent) {
        agent.updateBlock(this._currentLightHead, this._block);
    }

    /**
     * @param {Block} head
     * @private
     */
    async _announceHeadToNano(head) {
        this._currentLightHead = head.toLight();
        await this._updateTransactions();
    }

    async _updateTransactions() {
        try {
            this._block = await this._miner.getNextBlock();
            this._nextTransactions = this._block.body.transactions;
            this._nextPrunedAccounts = this._block.body.prunedAccounts;
            this._nextAccountsHash = this._block.header._accountsHash;
            this._nextBlockHeader = this._block.header;
            this._announceNewNextToNano();
        } catch(e) {
            setTimeout(() => this._updateTransactions(), 100);
        }
    }

    _announceNewNextToNano() {
        for (const poolAgent of this._agents.values()) {
            if (poolAgent.mode === PoolAgent.Mode.NANO || poolAgent.mode === PoolAgent.Mode.DUMB) {
                poolAgent.updateBlock(this._currentLightHead, this._block);
            }
        }
    }

    /**
     * @param {NetAddress} netAddress
     */
    banIp(netAddress) {
        if (!netAddress.isPrivate()) {
            Nimiq.Log.i(PoolServer, `Banning IP ${netAddress}`);
            if (netAddress.isIPv4()) {
                this._bannedIPv4IPs.put(netAddress, Date.now() + PoolServer.DEFAULT_BAN_TIME);
            } else if (netAddress.isIPv6()) {
                // Ban IPv6 IPs prefix based
                this._bannedIPv6IPs.put(netAddress.ip.subarray(0,8), Date.now() + PoolServer.DEFAULT_BAN_TIME);
            }
        }
    }

    /**
     * @param {NetAddress} netAddress
     * @returns {boolean}
     * @private
     */
    _isIpBanned(netAddress) {
        if (this._config.banned.includes(netAddress.toString())) return true;
        if (netAddress.isPrivate()) return false;
        if (netAddress.isIPv4()) {
            return this._bannedIPv4IPs.contains(netAddress);
        } else if (netAddress.isIPv6()) {
            const prefix = netAddress.ip.subarray(0, 8);
            return this._bannedIPv6IPs.contains(prefix);
        }
        return false;
    }

    _checkUnbanIps() {
        const now = Date.now();
        for (const netAddress of this._bannedIPv4IPs.keys()) {
            if (this._bannedIPv4IPs.get(netAddress) < now) {
                this._bannedIPv4IPs.remove(netAddress);
            }
        }
        for (const prefix of this._bannedIPv6IPs.keys()) {
            if (this._bannedIPv6IPs.get(prefix) < now) {
                this._bannedIPv6IPs.remove(prefix);
            }
        }
    }

    /**
     * @param {NetAddress} netAddress
     * @returns {boolean}
     * @private
     */
    _newIpConnTooMany(netAddress) {
        if (!netAddress.isPrivate()) {
            if (netAddress.isIPv4()) {
                const currTotalCount = this._connectionsPerIPv4.get(netAddress) || 0;
                const currRateCount = this._connectionsInTimePerIPv4.get(netAddress) || 0;
                if (currTotalCount >= this.config.maxConnPerIP || currRateCount >= this.config.maxConnInTimePerIP) {
                    return true;
                }
                this._connectionsPerIPv4.put(netAddress, currTotalCount + 1);
                this._connectionsInTimePerIPv4.put(netAddress, currRateCount + 1);
            } else if (netAddress.isIPv6()) {
                const prefix = netAddress.ip.subarray(0, 8);
                const currTotalCount = this._connectionsPerIPv6.get(prefix) || 0;
                const currRateCount = this._connectionsInTimePerIPv6.get(prefix) || 0;
                if (currTotalCount >= this.config.maxConnPerIP || currRateCount >= this.config.maxConnInTimePerIP) {
                    return true;
                }
                this._connectionsPerIPv6.put(prefix, currTotalCount + 1);
                this._connectionsInTimePerIPv6.put(prefix, currRateCount + 1);
            }
        }
        return false;
    }

    _calculateHashrate() {
        if (!this.consensus.established) return;

        const shareDifficulty = this._totalShareDifficulty.minus(this._lastShareDifficulty);
        this._lastShareDifficulty = this._totalShareDifficulty;

        const hashrate = shareDifficulty.div(PoolServer.HASHRATE_INTERVAL / 1000).times(Math.pow(2 ,16));
        this._hashrates.push(Math.round(hashrate.toNumber()));
        if (this._hashrates.length > 10) this._hashrates.shift();

        let hashrateSum = 0;
        for (const hr of this._hashrates) {
            hashrateSum += hr;
        }
        this._averageHashrate = hashrateSum / this._hashrates.length;

        Nimiq.Log.d(PoolServer, `Pool hashrate is ${Math.round(this._averageHashrate)} H/s (10 min average)`);
    }

    /**
     * @param {Address} address
     * @param {BlockHeader} header
     */
    storeShare(address, header) {
        let submittedShares;
        const addressKey = address.toBase64();
        if (!this._shares.contains(addressKey)) {
            submittedShares = new Nimiq.HashMap();
            this._shares.put(addressKey, submittedShares);
        } else {
            submittedShares = this._shares.get(addressKey);
        }
        let sharesForPrevious;
        if (!submittedShares.contains(header.prevHash.toString())) {
            sharesForPrevious = [];
            submittedShares.put(header.prevHash.toString(), sharesForPrevious);
        } else {
            sharesForPrevious = submittedShares.get(header.prevHash);
        }
        if (!sharesForPrevious.includes(header.hash().toString())) {
            sharesForPrevious.push(header.hash().toString());
        } else {
            throw new Error("Share inserted twice");
        }
    }

    /**
     * @param {Nimiq.Hash} oldShareHash
     * @private
     */
    async _removeOldShares(oldShareHash) {
        for (let addressKey of this._shares.keys()) {
            let addressHashesMap = this._shares.get(addressKey);
            for (let key of addressHashesMap.keys()) {
                if (key === oldShareHash.toString()) {
                    addressHashesMap.remove(key);
                } else {
                    const block = await this.consensus.blockchain.getBlock(Nimiq.Hash.fromBase64(key));
                    if (block && block.header.timestamp * 1000 > this.consensus.network.time + Nimiq.Block.TIMESTAMP_DRIFT_MAX * 1000) {
                        addressHashesMap.remove(key);
                    }
                }
            }
        }
    }

    /**
     * @param {PoolAgent} agent
     */
    removeAgent(agent) {
        if (agent.mode === PoolAgent.Mode.REMOVED) return;
        agent.mode = PoolAgent.Mode.REMOVED;
        if (!agent.netAddress.isPrivate()) {
            // Remove one connection from total count per IP
            if (agent.netAddress.isIPv4()) {
                const currTotalCount = this._connectionsPerIPv4.get(agent.netAddress) || 0;
                if (currTotalCount <= 1) {
                    this._connectionsPerIPv4.remove(agent.netAddress);
                }
                this._connectionsPerIPv4.put(agent.netAddress, currTotalCount - 1);
            } else if (agent.netAddress.isIPv6()) {
                const prefix = agent.netAddress.ip.subarray(0, 8);
                const currTotalCount = this._connectionsPerIPv6.get(prefix) || 0;
                if (currTotalCount <= 1) {
                    this._connectionsPerIPv6.remove(prefix);
                }
                this._connectionsPerIPv6.put(prefix, currTotalCount - 1);
            }
        }
        this._agents.delete(agent);
    }

    /**
     * @type {{ unregistered: number, smart: number, nano: number, dumb: number}}
     */
    getClientModeCounts() {
        let ret = { unregistered: 0, smart: 0, nano: 0, dumb: 0 };
        for (const agent of this._agents) {
            ret[agent.mode]++;
        }
        return ret;
    }

    /**
     * @type {Nimiq.FullConsensus}
     * */
    get consensus() {
        return this._consensus;
    }

    /** @type {PoolConfig} */
    get config() {
        return this._config;
    }

    /**
     * @type {number}
     */
    get numIpsBanned() {
        return this._bannedIPv4IPs.length + this._bannedIPv6IPs.length;
    }

    /**
     * @type {number}
     */
    get numBlocksMined() {
        return this._numBlocksMined;
    }

    /**
     * @type {number}
     */
    get totalShareDifficulty() {
        return this._totalShareDifficulty;
    }

    /**
     * @type {number}
     */
    get averageHashrate() {
        return this._averageHashrate;
    }
}
PoolServer.DEFAULT_BAN_TIME = 1000 * 60 * 10; // 10 minutes
PoolServer.UNBAN_IPS_INTERVAL = 1000 * 60; // 1 minute
PoolServer.HASHRATE_INTERVAL = 1000 * 60; // 1 minute

module.exports = exports = PoolServer;
