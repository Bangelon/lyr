const fs = require('fs');
const path = require('path');
const axios = require('axios');
const WebSocket = require('ws');
const colors = require('colors');
const readline = require('readline');
const { HttpsProxyAgent } = require('https-proxy-agent');

class Layernet {
    constructor(proxy) {
        this.dataFilePath = path.join(__dirname, 'data.txt');
        this.baseURL = 'https://api.netcoin.layernet.ai';
        this.ws = null;
        this.gameStarted = false;
        this.isRound2Active = false;
        this.claimingCoin = false;
        this.startingGame = false;
        this.gameCount = 1;
        this.maxGames = 5; // Số lần chơi game tối đa
        this.proxy = proxy;
        this.proxyAgent = this.proxy ? new HttpsProxyAgent(this.proxy) : null;
    }

    log(msg) {
        console.log(`[*] ${msg}`);
    }

    async getQueryIdAndUserData() {
        try {
            const data = fs.readFileSync(this.dataFilePath, 'utf8')
                .replace(/\r/g, '')
                .split('\n')
                .filter(Boolean);

            if (data.length === 0) {
                throw new Error('data.txt is empty or not found.');
            }

            const queryIdLine = data[0];
            const queryParams = new URLSearchParams(queryIdLine);
            const userDataString = queryParams.get('user');

            if (!userDataString) {
                throw new Error('User data not found in query_id.');
            }

            const userData = JSON.parse(decodeURIComponent(userDataString));

            if (!userData.id) {
                throw new Error('Invalid user data: id is missing.');
            }

            return { queryId: queryIdLine, userData };
        } catch (error) {
            console.error('Error reading query_id and user data:', error);
            throw error;
        }
    }

    async getAccessToken(queryId, userData) {
        const url = `${this.baseURL}/api/user/login`;
        const payload = {
            telegramId: userData.id,
            firstName: userData.first_name,
            lastName: userData.last_name,
            languageCode: userData.language_code,
            isVip: false
        };

        try {
            const response = await axios.post(url, payload, {
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${queryId}`,
                    'Origin': 'https://netcoin.layernet.ai',
                    'Referer': 'https://netcoin.layernet.ai/',
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
                },
                httpAgent: this.proxyAgent,
                httpsAgent: this.proxyAgent
            });

            if (response.data.success) {
                return response.data.data.accessToken;
            } else {
                throw new Error('Login failed');
            }
        } catch (error) {
            console.error('Error fetching access token:', error);
            throw error;
        }
    }

    async connectWebSocket(accessToken) {
        const wsURL = `${this.baseURL}/socket.io/?EIO=4&transport=websocket`;
        const headers = {
            'Origin': 'https://netcoin.layernet.ai',
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
        };

        this.ws = new WebSocket(wsURL, { headers, agent: this.proxyAgent });

        this.ws.on('open', () => {
            this.log('Đăng nhập thành công!');
            this.sendAuthMessage(accessToken);
        });

        this.ws.on('message', (message) => {
            this.handleMessage(message);
        });

        this.ws.on('close', () => {
            this.log('Dừng kết nối server!');
        });

        this.ws.on('error', (error) => {
            console.error('Lỗi kết nối tới server:', error);
        });
    }

    sendAuthMessage(accessToken) {
        const authMessage = JSON.stringify({ token: `Bearer ${accessToken}` });
        this.ws.send(`40${authMessage}`);
        setTimeout(() => this.sendHomeDataRequest(), 1000);
    }

    sendHomeDataRequest() {
        const homeDataRequest = JSON.stringify(["homeData"]);
        this.ws.send(`420${homeDataRequest}`);
    }

    handleMessage(message) {
        let messageStr = message.toString();
        const jsonMessageMatch = messageStr.match(/^\d+\[(\{.*\})\]$/);
        if (jsonMessageMatch) {
            try {
                const parsedMessage = JSON.parse(jsonMessageMatch[1]);
                if (parsedMessage[0] === "exception") {
                    const { message } = parsedMessage[1];
                    if (message === "Game not started" && this.isRound2Active) {
                        this.log('Game not started message received. Stopping Round 2.');
                        this.isRound2Active = false; 
                        this.sendHomeDataRequest(); 
                        return; 
                    }
                }
                this.processGameData(parsedMessage);
            } catch (error) {
                this.log(`Failed to parse message as JSON: ${error.message}`);
            }
        }
    }

    processGameData(data) {
        const { userRank, claimCountdown, gold, dogs } = data;
        if (userRank && claimCountdown) {
            const { role, profitPerHour } = userRank;
            const { minutes, seconds } = claimCountdown;
            this.log(`Role: ${role}, ProfitPerHour: ${profitPerHour}, Balance: ${gold}, DOGS: ${dogs}`);
            const totalMinutesRemaining = minutes + (seconds / 60);
            this.log(`Thời gian claim còn lại: ${minutes} phút ${seconds} giây`);
            if (!this.gameStarted && !this.claimingCoin && totalMinutesRemaining < 10) {
                this.claimCoin();
            }
            if (!this.startingGame) {
                setTimeout(() => this.startGame(), 3000);
            }
        }
    }
    
    async claimCoin() {
        if (this.claimingCoin) {
            this.log('Coin is already being claimed.');
            return; 
        }
        this.claimingCoin = true;
        this.log('Claiming coin...');
        const withdrawClaimMessage = JSON.stringify(['withdrawClaim']);
        this.ws.send(`42${withdrawClaimMessage}`);
        setTimeout(() => {
            this.claimingCoin = false; 
            this.sendHomeDataRequest(); 
        }, 2000); 
    }

    async startGame() {
        if (this.startingGame) return; 
        this.startingGame = true;
        this.log(`Bắt đầu chơi game, không đóng tool trước khi hoàn thành!`);
        const startGameMessage = JSON.stringify(["startGame"]);
        this.ws.send(`422${startGameMessage}`);

        this.gameStarted = true;
        this.isRound2Active = true;
        await this.playRound(1);
    }

    async playRound(roundNumber) {
        let bodem = 2;
        let messageCount = 0;
        const interval = setInterval(() => {
            if (messageCount < 60) {
                const inGameMessage = JSON.stringify(["inGame", { round: roundNumber, time: Date.now(), gameover: false }]);
                this.ws.send(`42${bodem}${inGameMessage}`);
                messageCount++;
                bodem++;
            } else {
                clearInterval(interval);
                if (roundNumber === 1) {
                    this.log('Hoàn thành round 1, bắt đầu Round 2.');
                    this.playRound2(2);
                }
            }
        }, 10000 / 60);
    }
    
    async playRound2(roundNumber) {
        let bodem = 63;
        let messageCount = 0;
        const interval = setInterval(() => {
            if (messageCount < 100) {
                if (this.isRound2Active) { 
                    const inGameMessage = JSON.stringify(["inGame", { round: roundNumber, time: Date.now(), gameover: false }]);
                    this.ws.send(`42${bodem}${inGameMessage}`);
                    messageCount++;
                    bodem++;
                }
            } else {
                clearInterval(interval);
                if (this.isRound2Active) {
                    this.log('Round 2 hoàn thành!');
                    this.sendHomeDataRequest();
                    this.isRound2Active = false; 
                    this.startingGame = false;
                    this.gameCount++;
                    if (this.gameCount < this.maxGames) {
                        this.log(`Bắt đầu lại game (${this.gameCount}/${this.maxGames})`);
                        setTimeout(() => this.startGame(), 1000); 
                    } else {
                        this.log('Hoàn thành tất cả các vòng chơi!');
                        this.ws.close();
                    }
                }
            }
        }, 50000 / 100);
    }

    async waitWithCountdown(seconds) {
        for (let i = seconds; i >= 0; i--) {
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(`[*] Cần chờ ${i} giây để tiếp tục...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        console.log('');
    }

    async checkProxyIP(proxy) {
        let attempts = 0;
        const maxAttempts = 5;
        while (attempts < maxAttempts) {
            try {
                const proxyAgent = new HttpsProxyAgent(proxy);
                const response = await axios.get('https://api.ipify.org?format=json', {
                    httpsAgent: proxyAgent
                });
                if (response.status === 200) {
                    return response.data.ip;
                } else {
                    throw new Error(`Không thể kiểm tra IP của proxy. Status code: ${response.status}`);
                }
            } catch (error) {
                attempts++;
                this.log(`Error khi kiểm tra IP của proxy (Lần thử ${attempts}/${maxAttempts}): ${error.message}`);
                if (attempts < maxAttempts) {
                    await this.sleep(2000);
                } else {
                    throw new Error(`Error khi kiểm tra IP của proxy sau ${maxAttempts} lần thử: ${error.message}`);
                }
            }
        }
    }

    async main() {
        try {
            const proxyList = fs.readFileSync(path.join(__dirname, 'proxy.txt'), 'utf8')
                .replace(/\r/g, '')
                .split('\n')
                .filter(Boolean);

            if (proxyList.length === 0) {
                throw new Error('proxy.txt is empty or not found.');
            }

            const data = fs.readFileSync(this.dataFilePath, 'utf8')
                .replace(/\r/g, '')
                .split('\n')
                .filter(Boolean);

            if (data.length === 0) {
                throw new Error('data.txt is empty or not found.');
            }

            for (let index = 0; index < data.length; index++) {
                const proxy = proxyList[index % proxyList.length];
                const layernet = new Layernet(proxy);

                const queryIdLine = data[index];
                const queryParams = new URLSearchParams(queryIdLine);
                const userDataString = queryParams.get('user');
                
                if (!userDataString) {
                    console.log(`Tài khoản ${index + 1}/${data.length}: Không tìm thấy dữ liệu người dùng.`);
                    continue;
                }

                const userData = JSON.parse(decodeURIComponent(userDataString));

                if (!userData.id) {
                    console.log(`Tài khoản ${index + 1}/${data.length}: ID người dùng không hợp lệ.`);
                    continue;
                }
                const ip = await this.checkProxyIP(proxy);
                console.log(`========== Tài khoản ${index + 1}/${data.length} | ${userData.first_name} | IP: ${ip} ==========`);
                const accessToken = await layernet.getAccessToken(queryIdLine, userData);
                await layernet.connectWebSocket(accessToken);

                await new Promise(resolve => layernet.ws.on('close', resolve));
                await this.waitWithCountdown(3);
            }

            await this.waitWithCountdown(30);

        } catch (error) {
            console.error('Lỗi trong quá trình xử lý:', error);
        }
    }    
}

if (require.main === module) {
    const layernet = new Layernet();
    layernet.main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}