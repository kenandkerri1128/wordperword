require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(express.static(path.join(__dirname, 'public')));

// --- Dictionary / Trie Setup ---
class TrieNode {
    constructor() { this.children = {}; this.isEndOfWord = false; }
}
class Trie {
    constructor() { this.root = new TrieNode(); }
    insert(word) {
        let current = this.root;
        for (let char of word) {
            if (!current.children[char]) current.children[char] = new TrieNode();
            current = current.children[char];
        }
        current.isEndOfWord = true;
    }
    search(word) {
        let current = this.root;
        for (let char of word) {
            if (!current.children[char]) return false;
            current = current.children[char];
        }
        return current.isEndOfWord;
    }
}

const dictionaryTrie = new Trie();
const allWords = [];

try {
    const dictPath = path.join(__dirname, 'words.txt');
    if (fs.existsSync(dictPath)) {
        const fileContent = fs.readFileSync(dictPath, 'utf-8');
        const words = fileContent.split(/\r?\n/);
        words.forEach(w => {
            const cleanWord = w.trim().toUpperCase();
            if (cleanWord) {
                dictionaryTrie.insert(cleanWord);
                allWords.push(cleanWord);
            }
        });
        console.log(`Dictionary loaded successfully! Total words: ${allWords.length}`);
    } else {
        console.warn("WARNING: words.txt not found.");
    }
} catch (err) {
    console.error("Error loading dictionary:", err);
}

const rooms = {}; 
let matchmakingQueue = [];
const onlineUsers = {}; 

function getRankData(lp) {
    if (lp <= 50) return { rank: "Novice Scribe", badge: "e.png" };
    if (lp <= 100) return { rank: "Apprentice Lexis", badge: "eplus.png" };
    if (lp <= 200) return { rank: "Word-Seeker", badge: "d.png" };
    if (lp <= 300) return { rank: "Fluent Phrase-Maker", badge: "dplus.png" };
    if (lp <= 400) return { rank: "Skilled Etymologist", badge: "c.png" };
    if (lp <= 500) return { rank: "Master of Letters", badge: "cplus.png" };
    if (lp <= 600) return { rank: "Eloquent Scholar", badge: "b.png" };
    if (lp <= 700) return { rank: "Renowned Author", badge: "bplus.png" };
    if (lp <= 800) return { rank: "Grand Lexicographer", badge: "a.png" };
    if (lp <= 900) return { rank: "Sage of the Script", badge: "aplus.png" };
    if (lp <= 999) return { rank: "Mythic Orator", badge: "s.png" };
    return { rank: "Genesis Lexicon God", badge: "splus.png" };
}

function getWordScore(wordLength) {
    if (wordLength < 3) return 0;
    if (wordLength === 3 || wordLength === 4) return 1;
    if (wordLength === 5) return 2;
    if (wordLength === 6) return 3;
    if (wordLength === 7) return 5;
    return 11;
}

function generateBoard() {
    const vowels = "AAAAAEEEEEEIIIIIOOOOOUUUUY";
    const consonants = "BBCCDDFFGGHHHJKLLLLMMNNNNPPQRRRRSSSSTTTTVVWXZ";
    let board = "";
    for (let i = 0; i < 12; i++) board += vowels.charAt(Math.floor(Math.random() * vowels.length));
    for (let i = 0; i < 24; i++) board += consonants.charAt(Math.floor(Math.random() * consonants.length));
    return board.split('').sort(() => 0.5 - Math.random()).join('');
}

async function getPlayerWorldRank(username, lp) {
    try {
        const { data: user } = await supabase.from('Wordiers').select('wins, losses').eq('username', username).single();
        const userWins = user && user.wins ? user.wins : 0;
        const userLosses = user && user.losses ? user.losses : 0;
        const userTotal = userWins + userLosses;
        const userWinRate = userTotal > 0 ? (userWins / userTotal) : 0;

        const { count: countGreaterLp, error: err1 } = await supabase
            .from('Wordiers')
            .select('*', { count: 'exact', head: true })
            .gt('lp', lp);
        
        const { data: sameLpPlayers, error: err2 } = await supabase
            .from('Wordiers')
            .select('username, wins, losses')
            .eq('lp', lp)
            .neq('username', username);

        let higherWinRateCount = 0;
        if (sameLpPlayers) {
            for (let p of sameLpPlayers) {
                const pWins = p.wins || 0;
                const pLosses = p.losses || 0;
                const pTotal = pWins + pLosses;
                const pWinRate = pTotal > 0 ? (pWins / pTotal) : 0;
                if (pWinRate > userWinRate) {
                    higherWinRateCount++;
                }
            }
        }

        if (err1) return "?";
        return countGreaterLp + higherWinRateCount + 1;
    } catch (e) {
        return "?";
    }
}

function broadcastRoomList() {
    const availableRooms = Object.keys(rooms).filter(id => rooms[id].isCustom && rooms[id].players.length < 4).map(id => ({
        id: id, players: rooms[id].players.length, isLocked: !!rooms[id].password
    }));
    io.emit('roomListUpdate', availableRooms);
}

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('register', async (data) => {
        if (onlineUsers[data.username]) return socket.emit('authError', 'Game already open in another tab.');
        const { data: existingUser } = await supabase.from('Wordiers').select('username').eq('username', data.username).single();
        if (existingUser) return socket.emit('authError', 'Username already exists.');

        const initialRankData = getRankData(0);
        const { error } = await supabase.from('Wordiers').insert([{ username: data.username, password: data.password, lp: 0, rank: initialRankData.rank, wins: 0, losses: 0 }]);
        
        if (error) socket.emit('authError', 'Database error.');
        else {
            currentUser = data.username;
            onlineUsers[currentUser] = socket.id;
            socket.emit('authSuccess', { username: currentUser, lp: 0, rank: initialRankData.rank, badge: initialRankData.badge });
            sendAdminUpdate();
        }
    });

    socket.on('login', async (data) => {
        if (onlineUsers[data.username]) return socket.emit('authError', 'Game already open in another tab.');
        const { data: user } = await supabase.from('Wordiers').select('*').eq('username', data.username).eq('password', data.password).single();
        
        if (user) {
            currentUser = user.username;
            onlineUsers[currentUser] = socket.id;
            const rankData = getRankData(user.lp);
            if (user.rank !== rankData.rank) await supabase.from('Wordiers').update({ rank: rankData.rank }).eq('username', user.username);
            
            socket.emit('authSuccess', { username: currentUser, lp: user.lp, rank: rankData.rank, badge: rankData.badge });
            sendAdminUpdate();
        } else {
            socket.emit('authError', 'Invalid username or password.');
        }
    });

    socket.on('reconnectUser', async (data) => {
        if (onlineUsers[data.username] && onlineUsers[data.username] !== socket.id) {
            return socket.emit('authError', 'Game already open in another tab.');
        }
        const { data: user } = await supabase.from('Wordiers').select('*').eq('username', data.username).eq('password', data.password).single();
        if (user) {
            currentUser = user.username;
            onlineUsers[currentUser] = socket.id;
            socket.username = currentUser;

            let activeRoom = null;
            for (const roomId in rooms) {
                if (rooms[roomId].players.includes(currentUser)) {
                    if (rooms[roomId].status === 'playing') {
                        activeRoom = rooms[roomId];
                        socket.join(roomId);
                        break;
                    } else {
                        handlePlayerLeave(socket, roomId);
                    }
                }
            }
            const rankData = getRankData(user.lp);
            if (activeRoom) {
                socket.emit('rejoinGame', {
                    roomId: activeRoom.id, board: activeRoom.board, players: activeRoom.players, time: activeRoom.time,
                    myScore: activeRoom.scores[currentUser], myWords: activeRoom.words[currentUser]
                });
            } else {
                socket.emit('authSuccess', { username: currentUser, lp: user.lp, rank: rankData.rank, badge: rankData.badge });
            }
            sendAdminUpdate();
        } else {
            socket.emit('authError', 'Session expired. Please log in again.');
        }
    });

    socket.on('logout', () => {
        if (currentUser) {
            for (const roomId in rooms) {
                if (rooms[roomId].players.includes(currentUser) && rooms[roomId].status === 'waiting') {
                    handlePlayerLeave(socket, roomId);
                }
            }
            delete onlineUsers[currentUser];
        }
        currentUser = null;
        sendAdminUpdate();
    });

    socket.on('sendChat', async (message) => {
        if (!currentUser) return;
        const { data: user } = await supabase.from('Wordiers').select('rank').eq('username', currentUser).single();
        io.emit('receiveChat', { username: currentUser, rank: user ? user.rank : "Unknown", message });
    });

    socket.on('getLeaderboard', async () => {
        const { data: topPlayers } = await supabase.from('Wordiers').select('username, lp, rank, wins, losses').order('lp', { ascending: false }).limit(10);
        if (topPlayers) {
            const mappedPlayers = topPlayers.map(p => ({ ...p, badge: getRankData(p.lp).badge }));
            socket.emit('updateLeaderboard', mappedPlayers);
        }
    });

    function beginGameSequence(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.isRankedWaiting = false; 
        room.status = 'playing'; 
        
        io.to(roomId).emit('gameLoading', { roomId: roomId, board: room.board, players: room.players });
        
        setTimeout(() => {
            if (rooms[roomId]) { 
                io.to(roomId).emit('gameStart', { roomId: roomId, board: room.board, players: room.players, time: room.time });
                startGameTimer(roomId);
                if (room.isAI) startAILogic(roomId);
            }
        }, 3000); 
    }

    socket.on('findMatch', async () => {
        if (!currentUser) return;
        const { data: userData } = await supabase.from('Wordiers').select('lp').eq('username', currentUser).single();
        const playerLp = userData ? userData.lp : 0;
        socket.lp = playerLp; 
        
        const rankData = getRankData(playerLp);
        const worldRank = await getPlayerWorldRank(currentUser, playerLp);
        const pDetails = { lpRank: rankData.rank, worldRank: worldRank };
        
        let joinedRoomId = null;
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room.isRankedWaiting && room.players.length < 4) {
                if (Math.abs(room.baseLp - playerLp) <= 200) {
                    joinedRoomId = roomId;
                    break;
                }
            }
        }
        
        if (joinedRoomId) {
            const room = rooms[joinedRoomId];
            socket.join(joinedRoomId);
            room.players.push(currentUser);
            room.scores[currentUser] = 0;
            room.words[currentUser] = [];
            room.readyStates[currentUser] = false;
            room.playerDetails[currentUser] = pDetails;
            io.to(joinedRoomId).emit('rankedLobbyUpdate', { roomId: joinedRoomId, players: room.players, readyStates: room.readyStates, playerDetails: room.playerDetails });
            return;
        }

        if (!matchmakingQueue.find(s => s.id === socket.id)) {
            matchmakingQueue.push(socket);
            socket.username = currentUser;
        }

        let matchedGroup = [];
        for (let i = 0; i < matchmakingQueue.length; i++) {
            if (Math.abs(matchmakingQueue[i].lp - playerLp) <= 200) {
                matchedGroup.push(matchmakingQueue[i]);
            }
        }

        if (matchedGroup.length >= 2) {
            matchedGroup.forEach(s => {
                matchmakingQueue = matchmakingQueue.filter(q => q.id !== s.id);
            });
            
            const roomId = 'ranked_' + Date.now();
            rooms[roomId] = {
                id: roomId,
                players: matchedGroup.map(s => s.username),
                readyStates: {},
                playerDetails: {},
                board: generateBoard(),
                time: 120,
                scores: {},
                words: {},
                isCustom: false,
                isAI: false,
                isRankedWaiting: true,
                status: 'waiting',
                baseLp: matchedGroup[0].lp 
            };
            
            for (let s of matchedGroup) {
                s.join(roomId);
                rooms[roomId].scores[s.username] = 0;
                rooms[roomId].words[s.username] = [];
                rooms[roomId].readyStates[s.username] = false;
                
                const sLp = s.lp; 
                const sWr = await getPlayerWorldRank(s.username, sLp);
                rooms[roomId].playerDetails[s.username] = { lpRank: getRankData(sLp).rank, worldRank: sWr };
            }
            
            io.to(roomId).emit('rankedLobbyUpdate', { roomId, players: rooms[roomId].players, readyStates: rooms[roomId].readyStates, playerDetails: rooms[roomId].playerDetails });
        } else {
            socket.emit('searchingMatch'); 
        }
    });

    socket.on('cancelMatch', () => {
        matchmakingQueue = matchmakingQueue.filter(s => s.id !== socket.id);
    });

    function handlePlayerLeave(sock, roomId) {
        const room = rooms[roomId];
        if (!room || room.status !== 'waiting') return;
        
        const userToLeave = sock.username;
        sock.leave(roomId);
        
        room.players = room.players.filter(p => p !== userToLeave);
        
        if (room.isRankedWaiting) {
            delete room.readyStates[userToLeave];
            if (room.playerDetails) delete room.playerDetails[userToLeave];
        }
        if (room.scores) delete room.scores[userToLeave];
        if (room.words) delete room.words[userToLeave];
        
        if (room.players.length === 0) {
            delete rooms[roomId];
        } else {
            if (room.isRankedWaiting) {
                if (room.players.length === 1) {
                    const lastUser = room.players[0];
                    const lastSocketId = onlineUsers[lastUser];
                    if (lastSocketId) {
                        const lastSocket = io.sockets.sockets.get(lastSocketId);
                        if (lastSocket) {
                            lastSocket.leave(roomId);
                            if (!matchmakingQueue.find(s => s.id === lastSocket.id)) {
                                matchmakingQueue.push(lastSocket);
                            }
                            lastSocket.emit('searchingMatch');
                        }
                    }
                    delete rooms[roomId];
                } else {
                    io.to(roomId).emit('rankedLobbyUpdate', { 
                        roomId, 
                        players: room.players, 
                        readyStates: room.readyStates,
                        playerDetails: room.playerDetails 
                    });
                }
            } else {
                if (room.host === userToLeave) room.host = room.players[0];
                io.to(roomId).emit('playerJoined', room.players);
            }
        }
        broadcastRoomList();
    }

    socket.on('leaveWaitingRoom', (roomId) => {
        handlePlayerLeave(socket, roomId);
    });

    socket.on('readyRanked', (roomId) => {
        const room = rooms[roomId];
        if (room && room.isRankedWaiting) {
            room.readyStates[currentUser] = true;
            io.to(roomId).emit('rankedLobbyUpdate', { roomId, players: room.players, readyStates: room.readyStates, playerDetails: room.playerDetails });
            
            const allReady = room.players.every(p => room.readyStates[p]);
            if (allReady && room.players.length >= 2) {
                beginGameSequence(roomId);
            }
        }
    });

    socket.on('getRoomList', () => {
        broadcastRoomList();
    });

    socket.on('createRoom', (password) => {
        if (!currentUser) return;
        const roomId = 'custom_' + Date.now();
        socket.join(roomId);
        socket.username = currentUser;
        rooms[roomId] = { 
            id: roomId, players: [currentUser], board: generateBoard(), time: 120, 
            scores: { [currentUser]: 0 }, words: { [currentUser]: [] }, isCustom: true, 
            host: currentUser, isAI: false, isRankedWaiting: false, status: 'waiting',
            password: password || null
        };
        socket.emit('roomCreated', roomId);
        io.to(roomId).emit('playerJoined', rooms[roomId].players);
        broadcastRoomList();
        sendAdminUpdate();
    });

    socket.on('joinRoom', (data) => {
        const { roomId, password } = data;
        if (!currentUser || !rooms[roomId] || rooms[roomId].players.length >= 4) {
            return socket.emit('roomError', 'Room unavailable.');
        }
        if (rooms[roomId].password && rooms[roomId].password !== password) {
            return socket.emit('roomError', 'Incorrect password.');
        }
        socket.join(roomId);
        socket.username = currentUser;
        rooms[roomId].players.push(currentUser);
        rooms[roomId].scores[currentUser] = 0;
        rooms[roomId].words[currentUser] = [];
        io.to(roomId).emit('playerJoined', rooms[roomId].players);
        broadcastRoomList();
        sendAdminUpdate();
    });

    socket.on('startCustomGame', (roomId) => {
        if (rooms[roomId] && rooms[roomId].host === currentUser) {
            if (rooms[roomId].players.length >= 2) {
                beginGameSequence(roomId);
            } else {
                socket.emit('roomError', 'A minimum of 2 players is required to start the game!');
            }
        }
    });

    socket.on('startAIMatch', () => {
        if (!currentUser) return;
        const roomId = 'ai_' + Date.now();
        socket.join(roomId);
        socket.username = currentUser;

        const aiPlayers = ['AI_Alpha', 'AI_Beta', 'AI_Gamma', 'AI_Delta'];
        const players = [currentUser, ...aiPlayers];

        rooms[roomId] = { id: roomId, players: players, board: generateBoard(), time: 120, scores: {}, words: {}, isCustom: false, isAI: true, isRankedWaiting: false, status: 'waiting', aiIntervals: [] };

        players.forEach(p => {
            rooms[roomId].scores[p] = 0;
            rooms[roomId].words[p] = [];
        });

        beginGameSequence(roomId);
        sendAdminUpdate();
    });

    function startAILogic(roomId) {
        const room = rooms[roomId];
        if (!room || allWords.length === 0) return;
        
        const aiPlayers = room.players.filter(p => p.startsWith('AI_'));
        aiPlayers.forEach(ai => {
            const interval = setInterval(() => {
                if (!rooms[roomId]) return clearInterval(interval);
                const randomWord = allWords[Math.floor(Math.random() * allWords.length)];
                if (randomWord.length >= 3 && randomWord.length <= 5 && !room.words[ai].includes(randomWord)) {
                    const points = getWordScore(randomWord.length);
                    room.scores[ai] += points;
                    room.words[ai].push(randomWord);
                    io.to(roomId).emit('spectatorUpdate', { player: ai, points: points });
                }
            }, 5000 + Math.random() * 6000); 
            room.aiIntervals.push(interval);
        });
    }

    socket.on('submitWord', (data) => {
        const { roomId, word } = data;
        const room = rooms[roomId];
        if (!room || !currentUser) return;

        const cleanWord = word.toUpperCase();
        if (cleanWord.length < 3 || room.words[currentUser].includes(cleanWord) || !dictionaryTrie.search(cleanWord)) {
            return socket.emit('wordResult', { success: false });
        }

        const points = getWordScore(cleanWord.length);
        room.scores[currentUser] += points;
        room.words[currentUser].push(cleanWord);

        socket.emit('wordResult', { success: true, word: cleanWord, points: points });
        socket.emit('myScoreUpdate', room.scores[currentUser]); 
        io.to(roomId).emit('spectatorUpdate', { player: currentUser, points: points });
    });

    socket.on('quitMatch', async (roomId) => {
        if (!currentUser || !rooms[roomId]) return;
        const room = rooms[roomId];
        room.scores[currentUser] = -9999; 
        socket.leave(roomId);
        
        const lpChange = room.isAI ? 0 : -20;
        const { data: userData } = await supabase.from('Wordiers').select('lp, wins, losses').eq('username', currentUser).single();
        let newLp = Math.max(0, (userData ? userData.lp : 0) + lpChange);
        let newLosses = (userData ? userData.losses : 0) + (room.isAI ? 0 : 1);
        const rankData = getRankData(newLp);
        
        await supabase.from('Wordiers').update({ lp: newLp, rank: rankData.rank, losses: newLosses }).eq('username', currentUser);
        socket.emit('quitSuccess', { lp: newLp, rank: rankData.rank, badge: rankData.badge, penalty: lpChange });
    });

    function startGameTimer(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        room.interval = setInterval(() => {
            room.time--;
            io.to(roomId).emit('timeUpdate', room.time);
            if (room.time <= 0) {
                clearInterval(room.interval);
                handleGameOver(roomId);
            }
        }, 1000);
    }

    async function handleGameOver(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        if (room.isAI) room.aiIntervals.forEach(clearInterval);

        const sortedPlayers = Object.keys(room.scores).sort((a, b) => room.scores[b] - room.scores[a]);
        const lpResults = {};

        const activePlayers = sortedPlayers.filter(p => !p.startsWith('AI_'));
        const pCount = activePlayers.length;

        const scoreGroups = {};
        activePlayers.forEach(p => {
            const score = room.scores[p];
            if (!scoreGroups[score]) scoreGroups[score] = [];
            scoreGroups[score].push(p);
        });

        const uniqueScores = Object.keys(scoreGroups).map(Number).sort((a, b) => b - a);
        const validPlayersCount = activePlayers.filter(p => onlineUsers[p] && room.scores[p] !== -9999).length;
        const isTotalTie = uniqueScores.length === 1 && validPlayersCount > 1;

        const lpAssignments = {};
        const isWinAssignments = {};

        if (isTotalTie) {
            activePlayers.forEach(p => {
                lpAssignments[p] = (!onlineUsers[p] || room.scores[p] === -9999) ? -20 : 0;
                isWinAssignments[p] = (!onlineUsers[p] || room.scores[p] === -9999) ? false : true;
            });
        } else {
            let placesTaken = 0;
            uniqueScores.forEach(score => {
                const tiedPlayers = scoreGroups[score];
                const numTied = tiedPlayers.length;
                const place = placesTaken + 1;
                const isLast = (placesTaken + numTied === pCount);

                let assignedLp = 0;

                if (isLast) {
                    assignedLp = -5;
                } else if (place === 1) {
                    if (numTied === 1) assignedLp = 20;
                    else if (numTied === 2) assignedLp = 10;
                    else if (numTied === 3) assignedLp = 6;
                } else if (place === 2) {
                    if (pCount === 4) {
                        if (numTied === 1) assignedLp = 5;
                        else if (numTied === 2) assignedLp = 2;
                        else if (numTied === 3) assignedLp = 1;
                    } else if (pCount === 3) {
                        if (numTied === 1) assignedLp = 0;
                    }
                } else if (place === 3) {
                    assignedLp = 0;
                }

                tiedPlayers.forEach(p => {
                    if (!onlineUsers[p] || room.scores[p] === -9999) {
                        lpAssignments[p] = -20;
                        isWinAssignments[p] = false;
                    } else {
                        lpAssignments[p] = assignedLp;
                        isWinAssignments[p] = assignedLp > 0;
                    }
                });

                placesTaken += numTied;
            });
        }

        for (const player of sortedPlayers) {
            if (player.startsWith('AI_')) {
                lpResults[player] = { username: player, score: room.scores[player], words: room.words[player] || [], lpChange: 0, newLp: 0, rank: "AI Engine", badge: "e.png" };
                continue;
            }

            let lpChange = 0;
            const isConnected = !!onlineUsers[player];
            const hasForfeited = room.scores[player] === -9999;

            if (room.isAI) {
                if (!isConnected || hasForfeited) {
                    lpChange = 0; 
                } else {
                    lpChange = room.scores[player] >= 10 ? Math.floor(room.scores[player] / 10) : 0;
                }
            } else {
                lpChange = lpAssignments[player];
            }

            const { data: userData } = await supabase.from('Wordiers').select('lp, wins, losses').eq('username', player).single();
            let newLp = Math.max(0, (userData ? userData.lp : 0) + lpChange);
            let newWins = userData && userData.wins ? userData.wins : 0;
            let newLosses = userData && userData.losses ? userData.losses : 0;
            const rankData = getRankData(newLp);

            if (!room.isAI && !hasForfeited) {
                if (isWinAssignments[player]) newWins++;
                else newLosses++;
                await supabase.from('Wordiers').update({ lp: newLp, rank: rankData.rank, wins: newWins, losses: newLosses }).eq('username', player);
            } else if (room.isAI && !hasForfeited) {
                await supabase.from('Wordiers').update({ lp: newLp, rank: rankData.rank }).eq('username', player);
            }
            
            lpResults[player] = { 
                username: player,
                score: hasForfeited ? 0 : room.scores[player], 
                words: room.words[player] || [], 
                lpChange: lpChange, 
                newLp: newLp, 
                rank: rankData.rank, 
                badge: rankData.badge 
            };
        }

        io.to(roomId).emit('gameOver', { results: lpResults, sortedPlayers: sortedPlayers });
        delete rooms[roomId];
        broadcastRoomList();
        sendAdminUpdate();
    }

    function sendAdminUpdate() {
        const activeRoomsData = Object.keys(rooms).map(id => ({ id, players: rooms[id].players, time: rooms[id].time }));
        io.emit('adminDataUpdate', { users: Object.keys(onlineUsers), rooms: activeRoomsData });
    }

    socket.on('requestAdminData', () => { if (currentUser === 'Kei') sendAdminUpdate(); });
    
    socket.on('adminKick', (targetUser) => {
        if (currentUser !== 'Kei') return;
        const targetSocketId = onlineUsers[targetUser];
        if (targetSocketId) {
            io.to(targetSocketId).emit('adminKicked');
            io.sockets.sockets.get(targetSocketId)?.disconnect();
        }
    });

    socket.on('adminBroadcast', (msg) => {
        if (currentUser === 'Kei') {
            io.emit('receiveChat', { username: 'SYSTEM', rank: 'Admin', message: msg });
        }
    });

    socket.on('adminSpectate', (roomId) => {
        if (currentUser === 'Kei' && rooms[roomId]) {
            socket.join(roomId);
            socket.emit('spectateStart', { roomId: roomId, board: rooms[roomId].board, players: rooms[roomId].players, time: rooms[roomId].time });
        }
    });

    socket.on('disconnect', () => {
        if (currentUser) {
            for (const roomId in rooms) {
                if (rooms[roomId].players.includes(currentUser) && rooms[roomId].status === 'waiting') {
                    handlePlayerLeave(socket, roomId);
                }
            }
            delete onlineUsers[currentUser];
        }
        matchmakingQueue = matchmakingQueue.filter(s => s.id !== socket.id);
        broadcastRoomList();
        sendAdminUpdate();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
