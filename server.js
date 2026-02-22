const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory databases
const users = {}; // username -> { password, lp, rank }
const rooms = {}; // roomId -> { players: [], board: "", time: 120, interval: null, scores: {}, words: {} }
let matchmakingQueue = [];

// Ranking Logic
function getRank(lp) {
    if (lp <= 50) return "Lower E-Rank";
    if (lp <= 100) return "Higher E Rank";
    if (lp <= 200) return "Lower D Rank";
    if (lp <= 300) return "Higher D Rank";
    if (lp <= 400) return "Lower C Rank";
    if (lp <= 500) return "Higher C Rank";
    if (lp <= 600) return "Lower B Rank";
    if (lp <= 700) return "Higher B Rank";
    if (lp <= 800) return "Lower A Rank";
    if (lp <= 900) return "Higher A Rank";
    if (lp <= 999) return "Lower S Rank";
    return "Higher S Rank";
}

// Word Factory Scoring
function getWordScore(wordLength) {
    if (wordLength < 3) return 0;
    if (wordLength === 3 || wordLength === 4) return 1;
    if (wordLength === 5) return 2;
    if (wordLength === 6) return 3;
    if (wordLength === 7) return 5;
    return 11;
}

// Generate 6x6 Board (36 letters)
function generateBoard() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let board = "";
    for (let i = 0; i < 36; i++) {
        board += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    return board;
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    let currentUser = null;

    // --- Authentication ---
    socket.on('register', (data) => {
        if (users[data.username]) {
            socket.emit('authError', 'Username already exists.');
        } else {
            users[data.username] = { password: data.password, lp: 0, rank: getRank(0) };
            currentUser = data.username;
            socket.emit('authSuccess', { username: currentUser, lp: 0, rank: getRank(0) });
        }
    });

    socket.on('login', (data) => {
        const user = users[data.username];
        if (user && user.password === data.password) {
            currentUser = data.username;
            user.rank = getRank(user.lp);
            socket.emit('authSuccess', { username: currentUser, lp: user.lp, rank: user.rank });
        } else {
            socket.emit('authError', 'Invalid username or password.');
        }
    });

    socket.on('logout', () => {
        currentUser = null;
    });

    // --- Lobby & Chat ---
    socket.on('sendChat', (message) => {
        if (!currentUser) return;
        const user = users[currentUser];
        io.emit('receiveChat', { username: currentUser, rank: user.rank, message });
    });

    // --- Matchmaking & Rooms ---
    socket.on('findMatch', () => {
        if (!currentUser) return;
        if (!matchmakingQueue.includes(socket)) {
            matchmakingQueue.push(socket);
            socket.username = currentUser;
        }

        // Start game if 4 players are in queue (or less if testing - currently set to 2 for easier testing, change to 4 for production)
        if (matchmakingQueue.length >= 2) { 
            const roomPlayers = matchmakingQueue.splice(0, 4);
            const roomId = 'room_' + Date.now();
            
            const board = generateBoard();
            rooms[roomId] = {
                id: roomId,
                players: roomPlayers.map(p => p.username),
                board: board,
                time: 120, // 2 minutes
                scores: {},
                words: {} // Tracks found words per player
            };

            roomPlayers.forEach(p => {
                p.join(roomId);
                rooms[roomId].scores[p.username] = 0;
                rooms[roomId].words[p.username] = [];
            });

            io.to(roomId).emit('gameStart', {
                roomId: roomId,
                board: board,
                players: rooms[roomId].players,
                time: 120
            });

            startGameTimer(roomId);
        }
    });

    socket.on('createRoom', () => {
        if (!currentUser) return;
        const roomId = 'custom_' + Date.now();
        socket.join(roomId);
        socket.username = currentUser;
        
        rooms[roomId] = {
            id: roomId,
            players: [currentUser],
            board: generateBoard(),
            time: 120,
            scores: { [currentUser]: 0 },
            words: { [currentUser]: [] },
            isCustom: true
        };
        socket.emit('roomCreated', roomId);
    });

    socket.on('joinRoom', (roomId) => {
        if (!currentUser || !rooms[roomId]) {
            socket.emit('roomError', 'Room not found.');
            return;
        }
        if (rooms[roomId].players.length >= 4) {
            socket.emit('roomError', 'Room is full.');
            return;
        }
        socket.join(roomId);
        socket.username = currentUser;
        rooms[roomId].players.push(currentUser);
        rooms[roomId].scores[currentUser] = 0;
        rooms[roomId].words[currentUser] = [];
        io.to(roomId).emit('playerJoined', rooms[roomId].players);
    });

    socket.on('startCustomGame', (roomId) => {
        if (rooms[roomId]) {
            io.to(roomId).emit('gameStart', {
                roomId: roomId,
                board: rooms[roomId].board,
                players: rooms[roomId].players,
                time: 120
            });
            startGameTimer(roomId);
        }
    });

    // --- Gameplay ---
    socket.on('submitWord', (data) => {
        const { roomId, word } = data;
        const room = rooms[roomId];
        if (!room || !currentUser) return;

        // Basic validation: Check if word was already found by this user
        if (room.words[currentUser].includes(word)) {
            socket.emit('wordResult', { success: false, message: 'Already found!' });
            return;
        }

        // Add dictionary check here in the future
        // For now, if it passes the client's adjacency grid check and length >= 3, we accept it
        if (word.length >= 3) {
            const points = getWordScore(word.length);
            room.scores[currentUser] += points;
            room.words[currentUser].push(word);

            socket.emit('wordResult', { success: true, word: word, points: points });
            io.to(roomId).emit('scoreUpdate', room.scores);
        } else {
            socket.emit('wordResult', { success: false, message: 'Word too short!' });
        }
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

    function handleGameOver(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        // Determine winner
        let highestScore = -1;
        let winners = [];
        for (const [player, score] of Object.entries(room.scores)) {
            if (score > highestScore) {
                highestScore = score;
                winners = [player];
            } else if (score === highestScore) {
                winners.push(player);
            }
        }

        // Assign LP
        const lpResults = {};
        room.players.forEach(player => {
            if (winners.includes(player) && highestScore > 0) {
                users[player].lp += 25; // Winner gets +25 LP
            } else {
                users[player].lp = Math.max(0, users[player].lp - 10); // Losers get -10 LP
            }
            users[player].rank = getRank(users[player].lp);
            lpResults[player] = { score: room.scores[player], newLp: users[player].lp, rank: users[player].rank };
        });

        io.to(roomId).emit('gameOver', { winners, results: lpResults });
        delete rooms[roomId];
    }

    socket.on('disconnect', () => {
        matchmakingQueue = matchmakingQueue.filter(s => s.id !== socket.id);
        console.log(`User disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});