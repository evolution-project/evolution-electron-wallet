import child_process from "child_process";
const request = require("request-promise");
const queue = require("promise-queue");
const http = require("http");
const fs = require("fs");
const path = require("path");
const zmq = require('zeromq')
const { fromEvent } = require('rxjs')

export class Daemon {
    constructor(backend) {
        this.backend = backend
        this.heartbeat = null
        this.heartbeat_slow = null
        this.id = 0
        this.testnet = false
        this.local = false // do we have a local daemon ?

        this.daemon_info = {}

        this.dealer = {}
        this.agent = new http.Agent({keepAlive: true, maxSockets: 1})
        this.queue = new queue(1, Infinity)
        this.zmq_enabled = false
    }


    checkVersion() {
        return new Promise((resolve, reject) => {
            if (process.platform === "win32") {
                let evolutiond_path = path.join(__evolution_bin, "evolutiond.exe")
                let evolutiond_version_cmd = `"${evolutiond_path}" --version`
                if (!fs.existsSync(evolutiond_path))
                    resolve(false)
                child_process.exec(evolutiond_version_cmd, (error, stdout, stderr) => {
                    if(error)
                        resolve(false)
                    resolve(stdout)
                })
            } else {
                let evolutiond_path = path.join(__evolution_bin, "evolutiond")
                let evolutiond_version_cmd = `"${evolutiond_path}" --version`
                if (!fs.existsSync(evolutiond_path))
                    resolve(false)
                child_process.exec(evolutiond_version_cmd, {detached: true}, (error, stdout, stderr) => {
                    if(error)
                        resolve(false)
                    resolve(stdout)
                })
            }
        })
    }

    checkRemoteHeight() {
        let url = "https://explorer.evolutionproject.space/api/networkinfo"
        if(this.testnet) {
            url = "https://stageblocks.arqma.com/api/networkinfo"
        }
        request(url).then(response => {
            try {
                const json = JSON.parse(response)
                if(json === null || typeof json !== "object" || !json.hasOwnProperty("data")) {
                    return
                }
                let desynced = false, system_clock_error = false
                if(json.data.hasOwnProperty("height") && this.blocks.current != null) {
                    this.remote_height = json.data.height
                }
                this.remote_height = 0
            } catch(error) {
                this.remote_height = 0
            }
        });
    }

    checkRemoteDaemon(options) {
        if(options.daemon.type == "local") {
            return new Promise((resolve, reject) => {
                resolve({
                    result: {
                        mainnet: !options.app.testnet,
                        testnet: options.app.testnet,
                    }
                })
            })
        } else {
            let uri = `http://${options.daemon.remote_host}:${options.daemon.remote_port}/json_rpc`
            return new Promise((resolve, reject) => {
                this.sendRPC("get_info", {}, uri).then((data) => {
                    resolve(data)
                })
            })
        }
    }

    start(options) {

        if(options.daemon.type === "remote") {

            this.local = false

            // save this info for later RPC calls
            this.protocol = "http://"
            this.hostname = options.daemon.remote_host
            this.port = options.daemon.remote_port

            return new Promise((resolve, reject) => {
                this.sendRPC("get_info").then((data) => {
                    if(!data.hasOwnProperty("error")) {
                        this.startHeartbeat()
                        resolve()
                    } else {
                        reject()
                    }
                })
            })
        }
        return new Promise((resolve, reject) => {

            this.local = true

            const args = [
                "--data-dir", options.app.data_dir,

                "--out-peers", options.daemon.out_peers,
                "--in-peers", options.daemon.in_peers,
                "--limit-rate-up", options.daemon.limit_rate_up,
                "--limit-rate-down", options.daemon.limit_rate_down,
                "--log-level", options.daemon.log_level,
                "--rpc-bind-ip", options.daemon.rpc_bind_ip,
                "--rpc-bind-port", options.daemon.rpc_bind_port
            ];
            if(options.daemon.type === 'local_zmq') {
                args.push("--zmq-enabled",
                          "--zmq-max_clients", 5,
                          "--zmq-bind-port",
                          options.daemon.zmq_bind_port)
            }
            this.zmq_enabled = options.daemon.type === 'local_zmq'
            if(options.daemon.enhanced_ip_privacy) {
                args.push(
                    "--p2p-bind-ip", "127.0.0.1",
                    "--p2p-bind-port", options.daemon.p2p_bind_port,
                    "--no-igd",
                    "--hide-my-port"
                )
            } else {
                args.push(
                    "--p2p-bind-ip", options.daemon.p2p_bind_ip,
                    "--p2p-bind-port", options.daemon.p2p_bind_port
                )
            }
            if(options.app.testnet) {
                this.testnet = true
                args.push("--testnet")
                args.push("--log-file", path.join(options.app.data_dir, "testnet", "logs", "arqmad.log"))
                //args.push("--add-peer", "45.77.68.151:13310")
            } else {
                args.push("--log-file", path.join(options.app.data_dir, "logs", "arqmad.log"))
            }

            if(options.daemon.rpc_bind_ip !== "127.0.0.1")
                args.push("--confirm-external-bind")

            if(options.daemon.type === "local_remote" && !options.app.testnet) {
                args.push(
                    "--bootstrap-daemon-address",
                    `${options.daemon.remote_host}:${options.daemon.remote_port}`
                )
            }

            if (process.platform === "win32") {
                this.daemonProcess = child_process.spawn(path.join(__arqma_bin, "arqmad.exe"), args)
            } else {
                this.daemonProcess = child_process.spawn(path.join(__arqma_bin, "arqmad"), args, {
                    detached: true
                })
            }

            // save this info for later RPC calls
            this.protocol = "http://"
            this.hostname = options.daemon.rpc_bind_ip
            this.port = options.daemon.rpc_bind_port
            this.daemonProcess.on("error", err => process.stderr.write(`Daemon: ${err}\n`))
            this.daemonProcess.on("close", code => process.stderr.write(`Daemon: exited with code ${code}\n`))
            if(options.daemon.type !== 'local_zmq') {
                this.daemonProcess.stdout.on("data", data => process.stdout.write(`Daemon: ${data}`))
                // To let caller know when the daemon is ready
                let intrvl = setInterval(() => {
                    this.sendRPC("get_info").then((data) => {
                        if(!data.hasOwnProperty("error")) {
                            clearInterval(intrvl);
                            this.startHeartbeat()
                            resolve();
                        } else {
                            if(data.error.cause &&
                               data.error.cause.code === "ECONNREFUSED") {
                                // Ignore
                            } else {
                                clearInterval(intrvl);
                                reject(error);
                            }
                        }
                    })
                }, 2000)
            } else {
                this.checkRemoteHeight()
                this.startZMQ(options);
                let getinfo = {"jsonrpc": "2.0",
                           "id": "1",
                           "method": "get_info",
                           "params": {}}
                this.dealer.send(['', JSON.stringify(getinfo)])
                resolve();
            }
        })
    }
    randomBetween(min, max) {
        return Math.floor(Math.random() * (max - min) + min);
    }
    randomString() {
        var source = 'abcdefghijklmnopqrstuvwxyz'
        var target = [];
        for (var i = 0; i < 20; i++) {
            target.push(source[this.randomBetween(0, source.length)]);
        }
        return target.join('');
    }


    startZMQ(options) {
        this.dealer = zmq.socket('dealer')
        this.dealer.identity = this.randomString();
        this.dealer.connect(`tcp://${options.daemon.rpc_bind_ip}:${options.daemon.zmq_bind_port}`);
        console.log(`Daemon Dealer connected to port ${options.daemon.rpc_bind_ip}:${options.daemon.zmq_bind_port}`);
        const zmqDirector = fromEvent(this.dealer, "message");
        zmqDirector.subscribe(x => {
                    let daemon_info = {
                    }
                    let results = JSON.parse(x.toString());
                    results.result.info.isDaemonSyncd = false
                    if (results.result.info.height === results.result.info.target_height && results.result.info.height >= this.remote_height) {
                        results.result.info.isDaemonSyncd = true
                    }
                    daemon_info.info = results.result.info
                    this.daemon_info = daemon_info
                    this.sendGateway("set_daemon_data", daemon_info)
                })
    }
    handle(data) {
        let params = data.data
        switch (data.method) {
            case "ban_peer":
                this.banPeer(params.host, params.seconds)
                break
            default:
        }
    }
    banPeer(host, seconds=3600) {
        if(!seconds)
            seconds=3600
        let params = {
            bans: [{
                host,
                seconds,
                ban: true
            }]
        }
        this.sendRPC("set_bans", params).then((data) => {
            if(data.hasOwnProperty("error") || !data.hasOwnProperty("result")) {
                this.sendGateway("show_notification", {type: "negative", message: "Error banning peer", timeout: 2000})
                return
            }
            let end_time = new Date(Date.now() + seconds * 1000).toLocaleString()
            this.sendGateway("show_notification", {message: "Banned "+host+" until "+end_time, timeout: 2000})
            // Send updated peer and ban list
            this.heartbeatSlowAction()
        })
    }
    timestampToHeight(timestamp, pivot=null, recursion_limit=null) {
        return new Promise((resolve, reject) => {
            if(timestamp > 999999999999) {
                // We have got a JS ms timestamp, convert
                timestamp = Math.floor(timestamp / 1000)
            }
            pivot = pivot || [137500, 1528073506]
            recursion_limit = recursion_limit || 0;
            let diff = Math.floor((timestamp - pivot[1]) / 120)
            let estimated_height = pivot[0] + diff
            if(estimated_height <= 0) {
                return resolve(0)
            }
            if(recursion_limit > 10) {
                return resolve(pivot[0])
            }
            this.getRPC("block_header_by_height", {height: estimated_height}).then((data) => {
                if(data.hasOwnProperty("error") || !data.hasOwnProperty("result")) {
                    if(data.error.code == -2) { // Too big height
                        this.getRPC("last_block_header").then((data) => {
                            if(data.hasOwnProperty("error") || !data.hasOwnProperty("result")) {
                                return reject()
                            }
                            let new_pivot = [data.result.block_header.height, data.result.block_header.timestamp]
                            // If we are within an hour that is good enough
                            // If for some reason there is a > 1h gap between blocks
                            // the recursion limit will take care of infinite loop
                            if(Math.abs(timestamp - new_pivot[1]) < 3600) {
                                return resolve(new_pivot[0])
                            }
                            // Continue recursion with new pivot
                            resolve(new_pivot)
                        })
                        return
                    } else {
                        return reject()
                    }
                }
                let new_pivot = [data.result.block_header.height, data.result.block_header.timestamp]
                // If we are within an hour that is good enough
                // If for some reason there is a > 1h gap between blocks
                // the recursion limit will take care of infinite loop
                if(Math.abs(timestamp - new_pivot[1]) < 3600) {
                    return resolve(new_pivot[0])
                }
                // Continue recursion with new pivot
                resolve(new_pivot)
            })
        }).then((pivot_or_height) => {
            return Array.isArray(pivot_or_height)
                ? this.timestampToHeight(timestamp, pivot_or_height, recursion_limit + 1)
                : pivot_or_height
        }).catch(error => {
            return false
        })
    }
    startHeartbeat() {
        clearInterval(this.heartbeat)
        this.heartbeat = setInterval(() => {
            this.heartbeatAction()
        }, this.local ? 5 * 1000 : 30 * 1000) // 5 seconds for local daemon, 30 seconds for remote
        this.heartbeatAction()
        clearInterval(this.heartbeat_slow)
        this.heartbeat_slow = setInterval(() => {
            this.heartbeatSlowAction()
        }, 30 * 1000) // 30 seconds
        this.heartbeatSlowAction()
    }
    heartbeatAction() {
        let actions = []
        // No difference between local and remote heartbeat action for now
        if(this.local) {
            actions = [
                this.getRPC("info")
            ]
        } else {
            actions = [
                this.getRPC("info")
            ]
        }
        Promise.all(actions).then((data) => {
            let daemon_info = {
            }
            for (let n of data) {
                if(n == undefined || !n.hasOwnProperty("result") || n.result == undefined)
                    continue
                if(n.method == "get_info") {
                    daemon_info.info = n.result
                    this.daemon_info = n.result
                }
            }
            this.sendGateway("set_daemon_data", daemon_info)
        })
    }
    heartbeatSlowAction() {
        let actions = []
        if(this.local) {
            actions = [
                this.getRPC("connections"),
                this.getRPC("bans"),
                //this.getRPC("txpool_backlog"),
            ]
        } else {
            actions = [
                //this.getRPC("txpool_backlog"),
            ]
        }
        if(actions.length === 0) return
        Promise.all(actions).then((data) => {
            let daemon_info = {
            }
            for (let n of data) {
                if(n == undefined || !n.hasOwnProperty("result") || n.result == undefined)
                    continue
                if (n.method == "get_connections" && n.result.hasOwnProperty("connections")) {
                    daemon_info.connections = n.result.connections
                } else if (n.method == "get_bans" && n.result.hasOwnProperty("bans")) {
                    daemon_info.bans = n.result.bans
                } else if (n.method == "get_txpool_backlog" && n.result.hasOwnProperty("backlog")) {
                    daemon_info.tx_pool_backlog = n.result.backlog
                }
            }
            this.sendGateway("set_daemon_data", daemon_info)
        })
    }
    sendGateway(method, data) {
        this.backend.send(method, data)
    }
    sendRPC(method, params={}, uri=false) {
        let id = this.id++
        let options = {
            uri: uri ? uri : `${this.protocol}${this.hostname}:${this.port}/json_rpc`,
            method: "POST",
            json: {
                jsonrpc: "2.0",
                id: id,
                method: method
            },
            agent: this.agent
        };
        if(Array.isArray(params) || Object.keys(params).length !== 0) {
            options.json.params = params
        }
        return this.queue.add(() => {
            return request(options)
                .then((response) => {
                    if(response.hasOwnProperty("error")) {
                        return {
                            method: method,
                            params: params,
                            error: response.error
                        }
                    }
                    return {
                        method: method,
                        params: params,
                        result: response.result
                    }
                }).catch(error => {
                    return {
                        method: method,
                        params: params,
                        error: {
                            code: -1,
                            message: "Cannot connect to daemon-rpc",
                            cause: error.cause
                        }
                    }
                })
        })
    }
    /**
     * Call one of the get_* RPC calls
     */
    getRPC(parameter, args) {
        return this.sendRPC(`get_${parameter}`, args);
    }
    quit() {
        // TODO force close after few seconds!
        clearInterval(this.heartbeat);
        if(this.zmq_enabled) {
            this.dealer.send(['', 'EVICT']);
            this.dealer.close()
            this.dealer = null
        }

        this.queue.queue = []
        return new Promise((resolve, reject) => {
            if (this.daemonProcess) {
                this.daemonProcess.on("close", code => {
                    this.agent.destroy()
                    resolve()
                })
                this.daemonProcess.kill()
            } else {
                resolve()
            }
        })
    }
}
