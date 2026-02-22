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
try {
    const dictPath = path.join(__dirname, 'words.txt');
    if (fs.existsSync(dictPath)) {
        const fileContent = fs.readFileSync(dictPath, 'utf-8');
        const words = fileContent.split(/\r?\n/);
        words.forEach(w => {
            const cleanWord = w.trim().toUpperCase();
            if (cleanWord) dictionaryTrie.insert(cleanWord);
        });
        console.log(`Dictionary loaded successfully!`);
    } else {
        console.warn("WARNING: words.txt not found.");
    }
} catch (err) {
    console.error("Error loading dictionary:", err);
}

// In-memory server data
const rooms = {}; 
let matchmakingQueue = [];
const onlineUsers = {}; // Tracks username to socket ID for Admin Panel

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

io.on('connection', (socket) => {
    let currentUser = null;

    // --- Authentication ---
    socket.on('register', async (data) => {
        const { data: existingUser } = await supabase.from('Wordiers').select('username').eq('username', data.username).single();
        if (existingUser) return socket.emit('authError', 'Username already exists.');

        const initialRankData = getRankData(0);
        const { error } = await supabase.from('Wordiers').insert([{ username: data.username, password: data.password, lp: 0, rank: initialRankData.rank }]);
        
        if (error) socket.emit('authError', 'Database error.');
        else {
            currentUser = data.username;
            onlineUsers[currentUser] = socket.id;
            socket.emit('authSuccess', { username: currentUser, lp: 0, rank: initialRankData.rank, badge: initialRankData.badge });
            sendAdminUpdate();
        }
    });

    socket.on('login', async (data) => {
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

    socket.on('logout', () => {
        if (currentUser) delete onlineUsers[currentUser];
        currentUser = null;
        sendAdminUpdate();
    });

    // --- Lobby & Chat ---
    socket.on('sendChat', async (message) => {
        if (!currentUser) return;
        const { data: user } = await supabase.from('Wordiers').select('rank').eq('username', currentUser).single();
        io.emit('receiveChat', { username: currentUser, rank: user ? user.rank : "Unknown", message });
    });

    socket.on('getLeaderboard', async () => {
        const { data: topPlayers } = await supabase.from('Wordiers').select('username, lp, rank').order('lp', { ascending: false }).limit(10);
        if (topPlayers) {
            const mappedPlayers = topPlayers.map(p => ({ ...p, badge: getRankData(p.lp).badge }));
            socket.emit('updateLeaderboard', mappedPlayers);
        }
    });

    // --- Multiplayer & Rooms ---
    socket.on('getRoomList', () => {
        const availableRooms = Object.keys(rooms).filter(id => rooms[id].isCustom && rooms[id].players.length < 4).map(id => ({
            id: id, players: rooms[id].players.length
        }));
        socket.emit('roomListUpdate', availableRooms);
    });

    socket.on('findMatch', () => {
        if (!currentUser) return;
        if (!matchmakingQueue.includes(socket)) {
            matchmakingQueue.push(socket);
            socket.username = currentUser;
        }

        if (matchmakingQueue.length >= 2) { 
            const roomPlayers = matchmakingQueue.splice(0, 4); // Max 4, min 2
            const roomId = 'room_' + Date.now();
            
            rooms[roomId] = { id: roomId, players: roomPlayers.map(p => p.username), board: generateBoard(), time: 120, scores: {}, words: {}, isCustom: false };
            roomPlayers.forEach(p => {
                p.join(roomId);
                rooms[roomId].scores[p.username] = 0;
                rooms[roomId].words[p.username] = [];
            });

            io.to(roomId).emit('gameStart', { roomId: roomId, board: rooms[roomId].board, players: rooms[roomId].players, time: 120 });
            startGameTimer(roomId);
            sendAdminUpdate();
        }
    });

    socket.on('createRoom', () => {
        if (!currentUser) return;
        const roomId = 'custom_' + Date.now();
        socket.join(roomId);
        socket.username = currentUser;
        rooms[roomId] = { id: roomId, players: [currentUser], board: generateBoard(), time: 120, scores: { [currentUser]: 0 }, words: { [currentUser]: [] }, isCustom: true, host: currentUser };
        socket.emit('roomCreated', roomId);
        sendAdminUpdate();
    });

    socket.on('joinRoom', (roomId) => {
        if (!currentUser || !rooms[roomId] || rooms[roomId].players.length >= 4) {
            return socket.emit('roomError', 'Room unavailable.');
        }
        socket.join(roomId);
        socket.username = currentUser;
        rooms[roomId].players.push(currentUser);
        rooms[roomId].scores[currentUser] = 0;
        rooms[roomId].words[currentUser] = [];
        io.to(roomId).emit('playerJoined', rooms[roomId].players);
        sendAdminUpdate();
    });

    socket.on('startCustomGame', (roomId) => {
        if (rooms[roomId] && rooms[roomId].host === currentUser) {
            io.to(roomId).emit('gameStart', { roomId: roomId, board: rooms[roomId].board, players: rooms[roomId].players, time: 120 });
            startGameTimer(roomId);
        }
    });

    // --- Gameplay (Hidden Scores) ---
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

        // ONLY emit back to the specific player to keep scores hidden from others
        socket.emit('wordResult', { success: true, word: cleanWord, points: points });
        socket.emit('myScoreUpdate', room.scores[currentUser]); 
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

        // Sort players by score descending
        const sortedPlayers = Object.keys(room.scores).sort((a, b) => room.scores[b] - room.scores[a]);
        const pCount = sortedPlayers.length;
        const lpResults = {};

        for (let i = 0; i < pCount; i++) {
            const player = sortedPlayers[i];
            let lpChange = 0;

            if (pCount === 4) {
                if (i === 0) lpChange = 20;
                else if (i === 1) lpChange = 5;
                else if (i === 2) lpChange = 0;
                else if (i === 3) lpChange = -5;
            } else if (pCount === 3) {
                if (i === 0) lpChange = 20;
                else if (i === 1) lpChange = 0;
                else if (i === 2) lpChange = -5;
            } else if (pCount === 2) {
                if (i === 0) lpChange = 20;
                else if (i === 1) lpChange = -5;
            } else {
                lpChange = 0; // Solo play/practice
            }

            const { data: userData } = await supabase.from('Wordiers').select('lp').eq('username', player).single();
            let newLp = Math.max(0, (userData ? userData.lp : 0) + lpChange);
            const rankData = getRankData(newLp);

            await supabase.from('Wordiers').update({ lp: newLp, rank: rankData.rank }).eq('username', player);
            lpResults[player] = { score: room.scores[player], words: room.words[player], lpChange: lpChange, newLp: newLp, rank: rankData.rank, badge: rankData.badge };
        }

        // Send all scores/words to everyone at the END
        io.to(roomId).emit('gameOver', { results: lpResults, sortedPlayers: sortedPlayers });
        delete rooms[roomId];
        sendAdminUpdate();
    }

    // --- Admin Panel Controls ---
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
        if (currentUser === 'Kei') io.emit('serverBroadcast', msg);
    });

    socket.on('adminSpectate', (roomId) => {
        if (currentUser === 'Kei' && rooms[roomId]) {
            socket.join(roomId);
            socket.emit('spectateStart', { roomId: roomId, board: rooms[roomId].board, players: rooms[roomId].players, time: rooms[roomId].time });
        }
    });

    socket.on('disconnect', () => {
        if (currentUser) delete onlineUsers[currentUser];
        matchmakingQueue = matchmakingQueue.filter(s => s.id !== socket.id);
        sendAdminUpdate();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
