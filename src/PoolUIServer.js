const Nimiq      = require("@nimiq/core");
const https      = require("https");
const mysql      = require("mysql2/promise");
const fs         = require("fs");
const PoolServer = require("./PoolServer.js");

const Helper = require('./Helper.js');

// Exists for development purposes when only running the endpoints using a stub index.js and PoolServer class.
const isFake = !!PoolServer.isFake;

const QUERIES = {
	currentStats : `SELECT  ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 10 MINUTE THEN s.difficulty ELSE 0 END) * POW(2, 16) / 3600) as hashrate0,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 1 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 21600) as hashrate1,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 3 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 86400) as hashrate3,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 6 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 21600) as hashrate6,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 86400) as hashrate24
						FROM shares s JOIN user u on u.id = s.user JOIN block b on b.id = s.prev_block WHERE
							FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR;`,
	statsForDevices : `SELECT s.device as deviceID,
							u.address as address,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 1 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 3600) as hashrate1,
							CAST(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 1 HOUR THEN s.count ELSE 0 END) AS UNSIGNED) as shares1,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 6 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 21600) as hashrate6,
							CAST(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 6 HOUR THEN s.count ELSE 0 END) AS UNSIGNED) as shares6,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 86400) as hashrate24,
							CAST(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR THEN s.count ELSE 0 END) AS UNSIGNED) as shares24
						FROM shares s JOIN user u on u.id = s.user JOIN block b on b.id = s.prev_block WHERE
							FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR GROUP BY device WITH ROLLUP;`,
	statsForAddresses : `SELECT u.address as address,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 1 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 3600) as hashrate1,
							CAST(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 1 HOUR THEN s.count ELSE 0 END) AS UNSIGNED) as shares1,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 6 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 21600) as hashrate6,
							CAST(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 6 HOUR THEN s.count ELSE 0 END) AS UNSIGNED) as shares6,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 86400) as hashrate24,
							CAST(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR THEN s.count ELSE 0 END) AS UNSIGNED) as shares24
						FROM shares s JOIN user u on u.id = s.user JOIN block b on b.id = s.prev_block WHERE
							FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR GROUP BY address WITH ROLLUP;`,
	statsForAddress : `SELECT u.address as address,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 1 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 3600) as hashrate1,
							CAST(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 1 HOUR THEN s.count ELSE 0 END) AS UNSIGNED) as shares1,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 6 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 21600) as hashrate6,
							CAST(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 6 HOUR THEN s.count ELSE 0 END) AS UNSIGNED) as shares6,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 86400) as hashrate24,
							CAST(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR THEN s.count ELSE 0 END) AS UNSIGNED) as shares24
						FROM shares s JOIN user u on u.id = s.user JOIN block b on b.id = s.prev_block WHERE
							address=? AND FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR GROUP BY user;`,
	devicesForAddress : `SELECT s.device as deviceID,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 1 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 3600) as hashrate1,
							CAST(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 1 HOUR THEN s.count ELSE 0 END) AS UNSIGNED) as shares1,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 6 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 21600) as hashrate6,
							CAST(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 6 HOUR THEN s.count ELSE 0 END) AS UNSIGNED) as shares6,
							ROUND(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 86400) as hashrate24,
							CAST(SUM(CASE WHEN FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR THEN s.count ELSE 0 END) AS UNSIGNED) as shares24
						FROM shares s JOIN user u on u.id = s.user JOIN block b on b.id = s.prev_block WHERE
							u.address=? AND FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR GROUP BY device;`,
	payoutsForAddress  : `SELECT address, amount, datetime as timestamp, transaction as txHash FROM payout p INNER JOIN user u ON u.id=p.user WHERE u.address=? ORDER BY datetime DESC LIMIT 50;`,
	blocksMinedForever : `SELECT main_chain as mainChain, count(distinct p.block) AS blockCount FROM block b JOIN payin p ON p.block = b.id GROUP BY b.main_chain;`,
	blocksMined24Hours : `SELECT main_chain as mainChain, count(distinct p.block) AS blockCount FROM block b JOIN payin p ON p.block = b.id WHERE FROM_UNIXTIME(b.datetime) > NOW() - INTERVAL 24 HOUR GROUP BY b.main_chain;`,
	blocksMinedList : `SELECT height, hash, datetime, height <= ? AS confirmed FROM payin p INNER JOIN block b ON p.block=b.id WHERE main_chain=1 GROUP BY height ORDER BY height DESC LIMIT 50;`,
	hashrateHistory : `SELECT datetime AS time, (SELECT ROUND(SUM(CASE WHEN FROM_UNIXTIME(a.datetime) > FROM_UNIXTIME(b.datetime) - INTERVAL 1 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 3600) FROM shares s JOIN block a ON s.prev_block=a.id WHERE FROM_UNIXTIME(a.datetime) < FROM_UNIXTIME(b.datetime) AND FROM_UNIXTIME(a.datetime) > FROM_UNIXTIME(b.datetime) - INTERVAL 1 HOUR) AS avgHR FROM block b WHERE (height%60=0 AND height<(SELECT MAX(height)-60 FROM block)) OR height=(SELECT MAX(height) FROM block) ORDER BY datetime DESC LIMIT 24`,
	minerHistory : `SELECT datetime AS time, (SELECT ROUND(SUM(CASE WHEN FROM_UNIXTIME(a.datetime) > FROM_UNIXTIME(b.datetime) - INTERVAL 1 HOUR THEN s.difficulty ELSE 0 END) * POW(2, 16) / 3600) FROM shares s JOIN block a ON s.prev_block=a.id JOIN user u ON u.id=s.user WHERE u.address=? AND FROM_UNIXTIME(a.datetime) < FROM_UNIXTIME(b.datetime) AND FROM_UNIXTIME(a.datetime) > FROM_UNIXTIME(b.datetime) - INTERVAL 1 HOUR GROUP BY user) AS avgHR FROM block b WHERE (height%60=0 AND height<(SELECT MAX(height)-60 FROM block)) OR height=(SELECT MAX(height) FROM block) ORDER BY datetime DESC LIMIT 24`,
	minerTotalPayedOut : `SELECT SUM(amount) as amount FROM payout p JOIN user u ON u.id=p.user WHERE u.address=? GROUP BY address`,
	minerTotalEarned : `SELECT SUM(amount) as amount FROM payin p JOIN user u ON u.id=p.user JOIN block b ON p.block=b.id WHERE u.address=? AND main_chain=1 GROUP BY address`,
	minerTotalOwed : `SELECT SUM(amount) - (SELECT SUM(amount) as amount FROM payout p JOIN user u ON u.id=p.user WHERE u.address=?) as amount FROM payin  p JOIN user u ON u.id=p.user JOIN block b ON p.block=b.id WHERE u.address=? AND main_chain=1 AND height <= ? GROUP BY address`
};

class PoolUIServer extends PoolServer {
	constructor(consensus, config, port, mySqlPsw, mySqlHost, sslKeyPath, sslCertPath, reverseProxy, poolHost) {
		super(consensus, config, port, mySqlPsw, mySqlHost, sslKeyPath, sslCertPath, reverseProxy);
		this.host = poolHost;
	}

	async start() {
		if (this._started) return;
		super.start();

		this.readOnlyConnection = await mysql.createPool({
			host: this._mySqlHost,
			user: "pool_info",
			password: "",
			database: "pool"
		});
	}

	async startServer(...args) {
		return await PoolUIServer.createServer(...args, this);
	}

	async queryDB(query, ...args) {
		return Helper.queryDB(this.readOnlyConnection, query, ...args);
	}

	static parseAddress(str) {
		try {
			let addr = Nimiq.Address.fromAny(str);
			return addr;
		} catch {
			return false;
		}
	}

	static createServer(port, sslKeyPath, sslCertPath, poolServer) {
		const sslOptions = {
			key: fs.readFileSync(sslKeyPath),
			cert: fs.readFileSync(sslCertPath)
		};
		const replyToRequest = (res, what, code = 200) => {
			res.writeHead(code);
			res.end(typeof what == "object" ? JSON.stringify(what, null, "\t") : what);
		};
		const rejectRequest = (res, why, code = 400) => {
			res.writeHead(code);
			res.end(typeof why == "object" ? JSON.stringify(why, null, "\t") : why);
		};

		let lastHRHistory = {
			time : 0,
			result : []
		};

		const routes = [
			{
				name : "Landing Page",
				path : "/",
				runs : (req, res) => {
					replyToRequest(res, "Nimiq Pool UI Server\n");
				}
			}, {
				name : "Pool Config",
				path : "/api/pool/config",
				runs : (req, res) => {
					let obj = {
						name : poolServer.name,
						address : poolServer.poolAddress.toUserFriendlyAddress(),
						host : poolServer.host,
						port : poolServer.port.toString(),
						description : poolServer.config.poolInfo.description,
						website : poolServer.config.poolInfo.websiteLink,
						community : poolServer.config.poolInfo.communityLink,
						fees : (poolServer.config.poolFee * 100).toFixed(2) + "%",
						payouts : poolServer.config.poolInfo.payoutType + " payouts " + poolServer.config.poolInfo.payoutFrequency + (poolServer.config.poolInfo.payoutFrequency ? " " : "") + "for balances over " + (poolServer.config.autoPayOutLimit / 100000).toFixed(2) + " NIM",
						supportsNano : poolServer.config.poolInfo.supportsNano
					};

					replyToRequest(res, obj);
				}
			}, {
				name : "Pool Stats",
				path : "/api/pool/stats",
				runs : async (req, res) => {
					let currentlyConnectedClients = isFake ? {} : poolServer.getClientModeCounts();
					currentlyConnectedClients.total = Object.values(currentlyConnectedClients).reduce((t, c) => t + c, 0);

					let blockStats24 = (await poolServer.queryDB(QUERIES.blocksMined24Hours)).filter(it => it.mainChain == 1).map(it => {
						return it.blockCount;
					});
					let blockStatsForever = (await poolServer.queryDB(QUERIES.blocksMinedForever)).filter(it => it.mainChain == 1).map(it => {
						return it.blockCount;
					});
					let obj = {
						name : poolServer.name,
						clientCounts : currentlyConnectedClients,
						averageHashrate : poolServer.averageHashrate,
						blocksMined : {
							sinceLastRestart : poolServer.numBlocksMined,
							inLast24Hours : blockStats24[0],
							total : blockStatsForever[0]
						},
					};

					replyToRequest(res, obj);
				}
			}, {
				name : "Pool History",
				path : "/api/pool/history",
				runs : async (req, res) => {
					let historyHR = null;

					let now = Date.now();
					if (now - lastHRHistory.time > (1000 * 60 * 15)) {
						historyHR = (await poolServer.queryDB(QUERIES.hashrateHistory)).map(it => {
							it.time = it.time * 1000;
							return it;
						});
						historyHR.reverse();

						lastHRHistory.time = now;
						lastHRHistory.result = historyHR;
					} else {
						historyHR = lastHRHistory.result;
					}

					let obj = {
						hashrate : historyHR
					};

					replyToRequest(res, obj);
				}
			}, {
				name : "Scary Pool Stats",
				path : "/api/owner/stats",
				runs : async (req, res) => {
					let currentlyConnectedClients = isFake ? {} : poolServer.getClientModeCounts();
					currentlyConnectedClients.total = Object.keys(currentlyConnectedClients).reduce((t, c) => t + c, 0);

					let blockStats24 = (await poolServer.queryDB(QUERIES.blocksMined24Hours)).filter(it => it.mainChain == 0).map(it => {
						return it.blockCount;
					});
					let blockStatsForever = (await poolServer.queryDB(QUERIES.blocksMinedForever)).filter(it => it.mainChain == 0).map(it => {
						return it.blockCount;
					});
					let obj = {
						unclesMined : {
							inLast24Hours : blockStats24[0],
							total : blockStatsForever[0]
						},
					};

					replyToRequest(res, obj);
				}
			}, {
				name : "Miner Stats",
				path : "/api/miner/(.*)",
				runs : async (req, res, arr) => {
					if (arr.length < 1) {
						return rejectRequest(res, {
							error : "URL Param missing, address expected after 'miner/'"
						});
					}

					let addr = PoolUIServer.parseAddress(arr[1]);

					if (!addr || (arr[1].startsWith("NQ") && arr[1].split(" ").join("") != addr.toUserFriendlyAddress().split(" ").join(""))) {
						return rejectRequest(res, {
							error : "Incorrectly formatted address : '" + arr[1] + "'"
						});
					}

					let miningStats = (await poolServer.queryDB(QUERIES.statsForAddress, addr.toBase64())).map(it => {
						return {
							address : PoolUIServer.parseAddress(it.address).toUserFriendlyAddress(),
							stats24 : { hash : it.hashrate24 , shares : it.shares24 },
							stats6  : { hash : it.hashrate6  , shares : it.shares6  },
							stats1  : { hash : it.hashrate1  , shares : it.shares1  }
						};
					});

					const blocksConfirmedHeight = poolServer.consensus.blockchain.height - poolServer.config.payoutConfirmations;

					let totalPayedOut = (await poolServer.queryDB(QUERIES.minerTotalPayedOut, addr.toBase64())).map(it => it.amount);
					let totalEarned = (await poolServer.queryDB(QUERIES.minerTotalEarned, addr.toBase64())).map(it => it.amount);
					let totalOwed = (await poolServer.queryDB(QUERIES.minerTotalOwed, addr.toBase64(), addr.toBase64(), blocksConfirmedHeight)).map(it => it.amount);

					let payoutStats = (await poolServer.queryDB(QUERIES.payoutsForAddress, addr.toBase64())).map(it => {
						return {
							amount : it.amount,
							timestamp : it.timestamp,
							txHash : /* "0x" + */ Nimiq.BufferUtils.toHex(Nimiq.SerialBuffer.from(it.txHash.data))
						};
					});

					let deviceStats = (await poolServer.queryDB(QUERIES.devicesForAddress, addr.toBase64())).map(it => {
						return {
							deviceID : it.deviceID,
							stats24 : { hash : it.hashrate24 , shares : it.shares24 },
							stats6  : { hash : it.hashrate6  , shares : it.shares6  },
							stats1  : { hash : it.hashrate1  , shares : it.shares1  }
						};
					});

					let historyHR = (await poolServer.queryDB(QUERIES.minerHistory, addr.toBase64())).map(it => {
						it.time = it.time * 1000;
						return it;
					});
					historyHR.reverse();

					replyToRequest(res, {
						general : miningStats.length > 0 ? miningStats[0] : null,
						payouts : payoutStats.length > 0 ? payoutStats : null,
						devices : deviceStats.length > 0 ? deviceStats : null,
						hashrate : historyHR.length > 0 ? historyHR : null,
						balance : {
							payedOut : totalPayedOut.length > 0 ? totalPayedOut[0] : 0,
							earned : totalEarned.length > 0 ? totalEarned[0] : 0,
							owed : totalOwed.length > 0 ? totalOwed[0] : 0
						}
					});
				}
			}, {
				name : "Miner List",
				path : "/api/list/miners",
				runs : async (req, res, arr) => {
					let result = await poolServer.queryDB(QUERIES.statsForAddresses);
					replyToRequest(res, result.map(it => {
						return {
							address : !it.address ? it.address : PoolUIServer.parseAddress(it.address).toUserFriendlyAddress(),
							stats24 : { hash : it.hashrate24 , shares : it.shares24 },
							stats6  : { hash : it.hashrate6  , shares : it.shares6  },
							stats1  : { hash : it.hashrate1  , shares : it.shares1  }
						};
					}));
				}
			}, {
				name : "Device List",
				path : "/api/list/devices",
				runs : async (req, res, arr) => {
					let result = await poolServer.queryDB(QUERIES.statsForDevices);
					replyToRequest(res, result.map(it => {
						return {
							deviceID : it.deviceID,
							// ownerAddress : PoolUIServer.parseAddress(it.address).toUserFriendlyAddress(),
							stats24 : { hash : it.hashrate24 , shares : it.shares24 },
							stats6  : { hash : it.hashrate6  , shares : it.shares6  },
							stats1  : { hash : it.hashrate1  , shares : it.shares1  }
						};
					}));
				}
			}, {
				name : "Blocks Mined List",
				path : "/api/list/blocks",
				runs : async (req, res, arr) => {
					const blocksConfirmedHeight = poolServer.consensus.blockchain.height - poolServer.config.payoutConfirmations;

					let result = (await poolServer.queryDB(QUERIES.blocksMinedList, blocksConfirmedHeight)).map(it => {
						return {
							height : it.height,
							timestamp : it.datetime * 1000,
							blockHash : /* "0x" + */ Nimiq.BufferUtils.toHex(Nimiq.SerialBuffer.from(it.hash.data)),
							confirmed : it.confirmed == 1
						};
					});
					replyToRequest(res, result);
				}
			}
		].map(it => {
			it.path = "/" + it.path.split("/").filter(it => !!it).join("/");
			return it;
		});

		const httpsServer = https.createServer(sslOptions, (req, res) => {
			let matchPath  = "/" + req.url.split("/").filter(it => !!it).join("/");
			let matching   = routes.filter(it => {
				return matchPath.match("^" + it.path + "$");
			}).filter(it => !!it);

			if (matching.length > 0) {
				try {
					let match = matchPath.match("^" + matching[0].path + "$");
					match = match ? match.map(unescape) : [];

					if (!matching[0].restrictAccess) {
						res.setHeader("Access-Control-Allow-Origin", "*");
					}

					if (req.method.toUpperCase() == "POST") {
						let body = "";
						req.on("data", chunk => {
							body += chunk.toString(); // convert Buffer to string
						});
						req.on("end", () => {
							req.body = body;
							matching[0].runs(req, res, match);
						});
					} else {
						matching[0].runs(req, res, match);
					}
				} catch (e) {
					console.error("Error while processing route : " + matching[0].name, e);
				}
			} else {
				res.writeHead(404);
				res.end("Page not found!");
			}
		});
		httpsServer.listen(port);

		Nimiq.Log.i(PoolUIServer, "Started server on port " + port);
		return httpsServer;
	}
}

module.exports = PoolUIServer;
