const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 10000;

const ADMIN_USER_ID = "10909271675";

const wss = new WebSocketServer({
    server,
    path: "/chat"
});

const rooms = new Map();

function createRoom(roomId) {
    const room = {
        clients: new Set(),
        bannedPlayerIds: new Set(),
        createdAt: Date.now()
    };

    rooms.set(roomId, room);
    return room;
}

function getRoom(roomId) {
    return rooms.get(roomId) || createRoom(roomId);
}

function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function broadcast(roomId, payload) {
    const room = rooms.get(roomId);
    if (!room) return;

    const message = JSON.stringify(payload);

    for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

function broadcastPresence(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    // Count unique Roblox player IDs instead of WebSocket connections
    const uniquePlayers = new Set();

    for (const client of room.clients) {
        if (client.playerId) {
            uniquePlayers.add(client.playerId);
        }
    }

    broadcast(roomId, {
        type: "presence",
        online: uniquePlayers.size
    });
}

function removeClientFromRoom(ws) {
    const roomId = ws.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    ws.roomId = null;

    if (!room) return;

    room.clients.delete(ws);

    if (room.clients.size === 0) {
        rooms.delete(roomId);
        return;
    }

    broadcastPresence(roomId);
}

app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "Roblox Chat Relay",
        rooms: rooms.size,
        connections: wss.clients.size
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok"
    });
});

wss.on("connection", (ws) => {
    ws.id = crypto.randomUUID();

    ws.roomId = null;
    ws.playerId = null;
    ws.displayName = null;
    ws.isAlive = true;

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    ws.on("message", (raw) => {
        let data;

        try {
            data = JSON.parse(raw.toString());
        } catch {
            send(ws, {
                type: "error",
                message: "Invalid JSON."
            });
            return;
        }

        if (data.type === "join") {
            const roomId = String(data.roomId || "").trim();
            const playerId = String(data.playerId || "").slice(0, 100);

            if (!roomId || roomId.length > 200) {
                send(ws, {
                    type: "error",
                    message: "Invalid room ID."
                });
                return;
            }

            if (!playerId) {
                send(ws, {
                    type: "error",
                    message: "Invalid player ID."
                });
                return;
            }

            const room = getRoom(roomId);

            // Check if this player is banned in this room
            if (room.bannedPlayerIds.has(playerId)) {
                send(ws, {
                    type: "error",
                    message: "You are banned from this chat room."
                });
                return;
            }

            removeClientFromRoom(ws);

            /*
             * If this same Roblox player already has another connection
             * in this room, close the older connection.
             *
             * This prevents the same player from appearing twice online.
             */
            for (const existingClient of room.clients) {
                if (
                    existingClient !== ws &&
                    existingClient.playerId === playerId
                ) {
                    try {
                        existingClient.close();
                    } catch {}

                    room.clients.delete(existingClient);
                }
            }

            ws.roomId = roomId;
            ws.playerId = playerId;
            ws.displayName = String(
                data.displayName || "Player"
            ).slice(0, 100);

            room.clients.add(ws);

            const uniquePlayers = new Set();

            for (const client of room.clients) {
                if (client.playerId) {
                    uniquePlayers.add(client.playerId);
                }
            }

            send(ws, {
                type: "joined",
                roomId: roomId,
                online: uniquePlayers.size
            });

            broadcastPresence(roomId);
            return;
        }

        if (!ws.roomId) return;

        const room = rooms.get(ws.roomId);
        if (!room) return;

        // Verify sender isn't banned
        if (room.bannedPlayerIds.has(ws.playerId)) {
            return;
        }

        if (data.type === "chat") {
            const text = String(data.text || "").trim();
            if (!text) return;

            broadcast(ws.roomId, {
                type: "chat",
                playerId: ws.playerId,
                displayName: ws.displayName,
                text: text.slice(0, 300),
                timestamp: Date.now()
            });

            return;
        }

        if (data.type === "admin_command") {

            // Server-side admin verification
            if (String(ws.playerId) !== ADMIN_USER_ID) {
                send(ws, {
                    type: "error",
                    message: "Unauthorized admin command."
                });
                return;
            }

            const commandString = String(
                data.commandString || ""
            ).trim();

            if (!commandString) return;

            // Check if command is a ban command: e.g. ";ban username"
            if (commandString.toLowerCase().startsWith(";ban ")) {
                const targetName = commandString
                    .slice(5)
                    .trim()
                    .toLowerCase();

                // Find client matching target display name or user ID
                for (const client of room.clients) {
                    if (
                        client.displayName.toLowerCase() === targetName ||
                        client.playerId === targetName
                    ) {
                        room.bannedPlayerIds.add(client.playerId);
                        break;
                    }
                }
            }

            // Broadcast command sync to all clients
            broadcast(ws.roomId, {
                type: "admin_sync",
                commandString: commandString.slice(0, 300),
                timestamp: Date.now()
            });

            return;
        }

        if (data.type === "ping") {
            send(ws, {
                type: "pong",
                timestamp: Date.now()
            });
            return;
        }
    });

    ws.on("close", () => {
        removeClientFromRoom(ws);
    });

    ws.on("error", () => {
        removeClientFromRoom(ws);
    });
});

const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) {
            ws.terminate();
            continue;
        }

        ws.isAlive = false;

        try {
            ws.ping();
        } catch {
            ws.terminate();
        }
    }
}, 30000);

function shutdown() {
    clearInterval(heartbeatInterval);

    for (const ws of wss.clients) {
        try {
            ws.close();
        } catch {}
    }

    server.close(() => {
        process.exit(0);
    });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Roblox Chat Relay running on port ${PORT}`);
});
