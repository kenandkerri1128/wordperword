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

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(express.static(path.join(__dirname, 'public')));

// --- Dictionary / Trie Setup ---
class TrieNode {
    constructor() {
        this.children = {};
        this.isEndOfWord = false;
    }
}

class Trie {
    constructor() {
        this.root = new TrieNode();
    }
    insert(word) {
        let current = this.root;
        for (let char of word) {
            if (!current.children[char]) {
                current.children[char] = new TrieNode();
            }
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

// Load the words.txt file into the Trie on server startup
try {
    const dictPath = path.join(__dirname, 'words.txt');
    if (fs.existsSync(dictPath)) {
        const fileContent = fs.readFileSync(dictPath, 'utf-8');
        const words = fileContent.split(/\r?\n/);
        let wordCount = 0;
        words.forEach(w => {
            const cleanWord = w.trim().toUpperCase();
            if (cleanWord) {
                dictionaryTrie.insert(cleanWord);
                wordCount++;
            }
        });
        console.log(`Dictionary loaded successfully with ${wordCount} words!`);
    } else {
        console.warn("WARNING: words.txt not found. Dictionary validation will fail.");
    }
} catch (err) {
    console.error("Error loading dictionary:", err);
}

// In-memory active game data
const rooms = {}; 
let matchmakingQueue = [];

// Ranking Logic (Linguist Theme)
function getRank(lp) {
    if (lp <= 50) return "Novice Scribe";
    if (lp <= 100) return "Apprentice Lexis";
    if (lp <= 200) return "Word-Seeker";
    if (lp <= 300) return "Fluent Phrase-Maker";
    if (lp <= 400) return "Skilled Etymologist";
    if (lp <= 500) return "Master of Letters";
    if (lp <= 600) return "Eloquent Scholar";
    if (lp <= 700) return "Renowned Author";
    if (lp <= 800) return "Grand Lexicographer";
    if (lp <= 900) return "Sage of the Script";
    if (lp <= 999) return "Mythic Orator";
    return "Genesis Lexicon God";
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
// Using standard Boggle letter distributions to make forming words easier
function generateBoard() {
    const vowels = "AAAAAEEEEEEIIIIIOOOOOUUUUY";
    const consonants = "BBCCDDFFGGHHHJKLLLLMMNNNNPPQRRRRSSSSTTTTVVWXZ";
    let board = "";
    
    // Ensure a decent mix of vowels and consonants for a 36-tile board
    for (let i = 0; i < 12; i++) {
        board += vowels.charAt(Math.floor(Math.random() * vowels.length));
    }
    for (let i = 0; i < 24; i++) {
        board += consonants.charAt(Math.floor(Math.random() * consonants.length));
    }
    
    // Shuffle the board string
    return board.split('').sort(() => 0.5 - Math.random()).join('');
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    let currentUser = null;

    // --- Authentication ---
    socket.on('register', async (data) => {
        const { data: existingUser, error: searchError } = await supabase
            .from('Wordiers')
            .select('username')
            .eq('username', data.username)
            .single();

        if (existingUser) {
            socket.emit('authError', 'Username already exists.');
            return;
        }

        const initialRank = getRank(0);
        
        const { error: insertError } = await supabase
            .from('Wordiers')
            .insert([{ username: data.username, password: data.password, lp: 0, rank: initialRank }]);

        if (insertError) {
            socket.emit('authError', 'Database error during registration.');
        } else {
            currentUser = data.username;
            socket.emit('authSuccess', { username: currentUser, lp: 0, rank: initialRank });
        }
    });

    socket.on('login', async (data) => {
        const { data: user, error } = await supabase
            .from('Wordiers')
            .select('*')
            .eq('username', data.username)
            .eq('password', data.password)
            .single();

        if (user) {
            currentUser = user.username;
            const currentRank = getRank(user.lp);
            if (user.rank !== currentRank) {
                await supabase.from('Wordiers').update({ rank: currentRank }).eq('username', user.username);
            }
            socket.emit('authSuccess', { username: currentUser, lp: user.lp, rank: currentRank });
        } else {
            socket.emit('authError', 'Invalid username or password.');
        }
    });

    socket.on('logout', () => {
        currentUser = null;
    });

    // --- Lobby & Chat ---
    socket.on('sendChat', async (message) => {
        if (!currentUser) return;
        const { data: user } = await supabase
            .from('Wordiers')
            .select('rank')
            .eq('username', currentUser)
            .single();
        const rank = user ? user.rank : "Unknown";
        io.emit('receiveChat', { username: currentUser, rank: rank, message });
    });

    // --- Leaderboard ---
    socket.on('getLeaderboard', async () => {
        const { data: topPlayers, error } = await supabase
            .from('Wordiers')
            .select('username, lp, rank')
            .order('lp', { ascending: false })
            .limit(10);
        if (!error && topPlayers) {
            socket.emit('updateLeaderboard', topPlayers);
        }
    });

    // --- Matchmaking & Rooms ---
    socket.on('findMatch', () => {
        if (!currentUser) return;
        if (!matchmakingQueue.includes(socket)) {
            matchmakingQueue.push(socket);
            socket.username = currentUser;
        }

        if (matchmakingQueue.length >= 2) { 
            const roomPlayers = matchmakingQueue.splice(0, 4);
            const roomId = 'room_' + Date.now();
            const board = generateBoard();
            
            rooms[roomId] = {
                id: roomId,
                players: roomPlayers.map(p => p.username),
                board: board,
                time: 120,
                scores: {},
                words: {} 
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

    // --- Gameplay / Dictionary Validation ---
    socket.on('submitWord', (data) => {
        const { roomId, word } = data;
        const room = rooms[roomId];
        if (!room || !currentUser) return;

        const cleanWord = word.toUpperCase();

        if (cleanWord.length < 3) {
            socket.emit('wordResult', { success: false, message: 'Word too short!' });
            return;
        }

        if (room.words[currentUser].includes(cleanWord)) {
            socket.emit('wordResult', { success: false, message: 'Already found!' });
            return;
        }

        // Check against our Trie Dictionary!
        if (!dictionaryTrie.search(cleanWord)) {
            socket.emit('wordResult', { success: false, message: 'Not a valid English word!' });
            return;
        }

        // If it passes the dictionary check, award points
        const points = getWordScore(cleanWord.length);
        room.scores[currentUser] += points;
        room.words[currentUser].push(cleanWord);

        socket.emit('wordResult', { success: true, word: cleanWord, points: points });
        io.to(roomId).emit('scoreUpdate', room.scores);
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

        const lpResults = {};

        for (const player of room.players) {
            const { data: userData } = await supabase
                .from('Wordiers')
                .select('lp')
                .eq('username', player)
                .single();

            let currentLp = userData ? userData.lp : 0;
            let newLp = currentLp;

            if (winners.includes(player) && highestScore > 0) {
                newLp += 25; 
            } else {
                newLp = Math.max(0, newLp - 10); 
            }

            const newRank = getRank(newLp);

            await supabase
                .from('Wordiers')
                .update({ lp: newLp, rank: newRank })
                .eq('username', player);

            lpResults[player] = { score: room.scores[player], newLp: newLp, rank: newRank };
        }

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
