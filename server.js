const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// Configuration de la base de données SQLite
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Erreur lors de la connexion à la base de données:', err.message);
    } else {
        console.log('Connecté à la base de données SQLite.');
        initDb();
    }
});

function initDb() {
    // Création de la table utilisateurs
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        avatarUrl TEXT,
        themeColor TEXT DEFAULT '#6366f1'
    )`);

    // Gérer l'ajout de la colonne themeColor si elle n'existe pas (migration simple)
    db.run(`ALTER TABLE users ADD COLUMN themeColor TEXT DEFAULT '#6366f1'`, (err) => {
        // Ignorer l'erreur si la colonne existe déjà
    });

    // Création de la table pour les messages (historique)
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT,
        username TEXT,
        text TEXT,
        timestamp INTEGER,
        FOREIGN KEY(userId) REFERENCES users(id)
    )`);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // Pour lire le body JSON pour les requêtes API

// stocker temporairement l'état des connexions (voix, sockets actuels)
const activeSockets = new Map(); // socket.id -> { userId, inVoice }

io.on('connection', (socket) => {
    console.log('Nouvelle connexion socket:', socket.id);

    // Événement d'authentification ou création de session
    socket.on('user:join', (userData) => {
        // userData devrait contenir : { userId, username, avatarUrl, themeColor }
        const { userId, username, avatarUrl, themeColor } = userData;
        const tColor = themeColor || '#6366f1';

        // Enregistrer ou mettre à jour l'utilisateur en base
        db.run(`INSERT INTO users (id, username, avatarUrl, themeColor) 
              VALUES (?, ?, ?, ?) 
              ON CONFLICT(id) DO UPDATE SET 
              username=excluded.username, 
              avatarUrl=excluded.avatarUrl,
              themeColor=excluded.themeColor`,
            [userId, username, avatarUrl, tColor],
            (err) => {
                if (err) console.error("Erreur save user:", err);
            }
        );

        activeSockets.set(socket.id, { userId, inVoice: false });

        // Renvoyer le vrai thème de la DB à l'utilisateur
        db.get(`SELECT themeColor FROM users WHERE id = ?`, [userId], (err, row) => {
            if (row && row.themeColor) {
                socket.emit('user:theme-updated', row.themeColor);
            }
        });

        // Envoyer l'historique des 50 derniers messages au nouveau venu
        db.all(`SELECT * FROM messages ORDER BY timestamp DESC LIMIT 50`, [], (err, rows) => {
            if (!err) {
                const history = rows.reverse(); // remettre dans l'ordre chrono
                socket.emit('chat:history', history);
            }
        });

        // Notifier les autres
        socket.broadcast.emit('user:joined', { userId, username });

        // Mettre à jour la liste des utilisateurs connectés
        broadcastActiveUsers();
    });

    socket.on('chat:message', (text) => {
        const activeObj = activeSockets.get(socket.id);
        if (activeObj) {
            db.get(`SELECT username FROM users WHERE id = ?`, [activeObj.userId], (err, row) => {
                if (row) {
                    const timestamp = Date.now();
                    // Sauvegarder en base
                    db.run(`INSERT INTO messages (userId, username, text, timestamp) VALUES (?, ?, ?, ?)`,
                        [activeObj.userId, row.username, text, timestamp]
                    );

                    // Diffuser à tout le monde
                    io.emit('chat:message', {
                        userId: activeObj.userId,
                        username: row.username,
                        text: text,
                        timestamp: timestamp
                    });
                }
            });
        }
    });

    // Mise à jour du thème
    socket.on('user:update-theme', (color) => {
        const activeObj = activeSockets.get(socket.id);
        if (activeObj) {
            db.run(`UPDATE users SET themeColor = ? WHERE id = ?`, [color, activeObj.userId]);
        }
    });

    // --- WebRTC Signaling ---
    socket.on('voice:join', () => {
        const activeObj = activeSockets.get(socket.id);
        if (activeObj) {
            activeObj.inVoice = true;

            // Il faut envoyer le pseudo de CE nouvel utilisateur aux autres,
            // MAIS il faut aussi récupérer le pseudo de TOUS les autes pour l'envoyer à ce nouvel utilisateur.
            const userIdsInVoice = [];
            const socketMap = {}; // mapping userId -> socketId

            for (const [sId, aObj] of activeSockets.entries()) {
                if (aObj.inVoice) {
                    userIdsInVoice.push(aObj.userId);
                    if (sId !== socket.id) socketMap[aObj.userId] = sId;
                }
            }

            if (userIdsInVoice.length > 0) {
                const placeholders = userIdsInVoice.map(() => '?').join(',');
                db.all(`SELECT id, username FROM users WHERE id IN (${placeholders})`, userIdsInVoice, (err, rows) => {
                    if (!err && rows) {
                        let myUsername = "Inconnu";
                        const othersInVoice = [];

                        rows.forEach(row => {
                            if (row.id === activeObj.userId) {
                                myUsername = row.username;
                            } else if (socketMap[row.id]) {
                                othersInVoice.push({ socketId: socketMap[row.id], userId: row.id, username: row.username });
                            }
                        });

                        // On envoie la liste complete (avec pseudo) à celui qui rejoint
                        socket.emit('voice:others', othersInVoice);

                        // On avertit les autres que quelqu'un a rejoint
                        socket.broadcast.emit('voice:user-joined', { socketId: socket.id, userId: activeObj.userId, username: myUsername });
                    }
                });
            }
        }
    });

    socket.on('voice:leave', () => {
        const activeObj = activeSockets.get(socket.id);
        if (activeObj && activeObj.inVoice) {
            activeObj.inVoice = false;
            socket.broadcast.emit('voice:user-left', socket.id);
        }
    });

    socket.on('voice:offer', payload => {
        io.to(payload.target).emit('voice:offer', {
            caller: socket.id,
            sdp: payload.sdp,
            userId: payload.userId // Pour identifier qui appelle côté client
        });
    });

    socket.on('voice:answer', payload => {
        io.to(payload.target).emit('voice:answer', {
            caller: socket.id,
            sdp: payload.sdp
        });
    });

    socket.on('voice:ice-candidate', payload => {
        io.to(payload.target).emit('voice:ice-candidate', {
            caller: socket.id,
            candidate: payload.candidate
        });
    });
    // --- YouTube Watch Party ---
    socket.on('youtube:start', (videoId) => {
        socket.broadcast.emit('youtube:start', videoId);
    });

    socket.on('youtube:stop', () => {
        socket.broadcast.emit('youtube:stop');
    });

    socket.on('youtube:sync', (data) => {
        socket.broadcast.emit('youtube:sync', data);
    });

    // --- Ping ---
    socket.on('ping:measure', (timestamp) => {
        socket.emit('ping:result', timestamp);
    });
    // ------------------------

    socket.on('disconnect', () => {
        const activeObj = activeSockets.get(socket.id);
        if (activeObj) {
            if (activeObj.inVoice) {
                socket.broadcast.emit('voice:user-left', socket.id);
            }
            activeSockets.delete(socket.id);

            db.get(`SELECT username FROM users WHERE id = ?`, [activeObj.userId], (err, row) => {
                if (row) socket.broadcast.emit('user:left', { userId: activeObj.userId, username: row.username });
            });

            broadcastActiveUsers();
        }
    });

    function broadcastActiveUsers() {
        // Récupérer les infos complètes depuis la base pour chaque utilisateur actif
        const userIds = Array.from(new Set(Array.from(activeSockets.values()).map(o => o.userId)));
        if (userIds.length === 0) {
            io.emit('users:update', []);
            return;
        }
        const placeholders = userIds.map(() => '?').join(',');
        db.all(`SELECT id, username, avatarUrl, themeColor FROM users WHERE id IN (${placeholders})`, userIds, (err, rows) => {
            if (!err) {
                io.emit('users:update', rows);
            }
        });
    }
});

// Arrêt propre
process.on('SIGINT', () => {
    db.close(() => {
        console.log('Base de données SQLite fermée.');
        process.exit(0);
    });
});

server.listen(PORT, () => {
    console.log(`Le serveur écoute sur http://localhost:${PORT}`);
});
