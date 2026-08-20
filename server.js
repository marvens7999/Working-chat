const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 10000;

//==========================================================
// CONFIG
//==========================================================

const ADMIN_USER_ID = "10909271675";

const wss = new WebSocketServer({
    server,
    path: "/chat"
});

//==========================================================
// ROOMS
//==========================================================

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

//==========================================================
// SOCKET HELPERS
//==========================================================

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

//==========================================================
// GLOBAL BROADCAST
// Sends to EVERY connected client in EVERY room.
//==========================================================

function broadcastGlobal(payload) {
    const message = JSON.stringify(payload);

    for (const room of rooms.values()) {
        for (const client of room.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        }
    }
}

//==========================================================
// PRESENCE
//==========================================================

function broadcastPresence(roomId) {
    const room = rooms.get(roomId);

    if (!room) return;

    broadcast(roomId, {
        type: "presence",
        online: room.clients.size
    });
}

//==========================================================
// REMOVE CLIENT
//==========================================================

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

//==========================================================
// ADMIN CHECK
//==========================================================

function isAdmin(ws) {
    return String(ws.playerId) === ADMIN_USER_ID;
}

//==========================================================
// FIND PLAYER
//==========================================================

function findPlayerInRoom(room, targetName) {
    targetName = String(targetName || "")
        .trim()
        .toLowerCase();

    if (!targetName) return null;

    for (const client of room.clients) {
        const displayName = String(
            client.displayName || ""
        ).toLowerCase();

        const playerId = String(
            client.playerId || ""
        ).toLowerCase();

        if (
            displayName === targetName ||
            playerId === targetName
        ) {
            return client;
        }
    }

    return null;
}

//==========================================================
// HTTP
//==========================================================

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

//==========================================================
// WEBSOCKET CONNECTION
//==========================================================

wss.on("connection", (ws) => {

    ws.id = crypto.randomUUID();

    ws.roomId = null;
    ws.playerId = null;
    ws.displayName = null;
    ws.isAlive = true;

    //======================================================
    // HEARTBEAT RESPONSE
    //======================================================

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    //======================================================
    // MESSAGE
    //======================================================

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

        //==================================================
        // JOIN
        //==================================================

        if (data.type === "join") {

            const roomId = String(
                data.roomId || ""
            ).trim();

            const playerId = String(
                data.playerId || ""
            ).slice(0, 100);

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

            // Check room ban
            if (room.bannedPlayerIds.has(playerId)) {

                send(ws, {
                    type: "error",
                    message: "You are banned from this chat room."
                });

                return;
            }

            // Remove any previous connection
            removeClientFromRoom(ws);

            ws.roomId = roomId;
            ws.playerId = playerId;

            ws.displayName = String(
                data.displayName || "Player"
            ).slice(0, 100);

            room.clients.add(ws);

            send(ws, {
                type: "joined",
                roomId: roomId,
                online: room.clients.size,
                isAdmin: isAdmin(ws)
            });

            broadcastPresence(roomId);

            return;
        }

        //==================================================
        // REQUIRE JOIN
        //==================================================

        if (!ws.roomId) {
            return;
        }

        const room = rooms.get(ws.roomId);

        if (!room) {
            return;
        }

        //==================================================
        // BANNED CHECK
        //==================================================

        if (room.bannedPlayerIds.has(ws.playerId)) {
            return;
        }

        //==================================================
        // NORMAL CHAT
        //==================================================

        if (data.type === "chat") {

            const text = String(
                data.text || ""
            ).trim();

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

        //==================================================
        // ADMIN COMMAND
        //==================================================

        if (data.type === "admin_command") {

            // Only your account can send admin commands.
            if (!isAdmin(ws)) {

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

            const lowerCommand =
                commandString.toLowerCase();

            //================================================
            // GLOBAL ANNOUNCEMENT
            //
            // ;gannounce Hello everyone
            // ;globalannounce Hello everyone
            //================================================

            if (
                lowerCommand === ";gannounce" ||
                lowerCommand.startsWith(";gannounce ") ||
                lowerCommand === ";globalannounce" ||
                lowerCommand.startsWith(";globalannounce ")
            ) {

                let announcement = "";

                if (
                    lowerCommand === ";globalannounce" ||
                    lowerCommand.startsWith(";globalannounce ")
                ) {

                    announcement = commandString
                        .slice(15)
                        .trim();

                } else {

                    announcement = commandString
                        .slice(10)
                        .trim();
                }

                if (!announcement) {

                    send(ws, {
                        type: "error",
                        message: "Global announcement text is empty."
                    });

                    return;
                }

                const cleanAnnouncement =
                    announcement.slice(0, 300);

                // Sends to EVERY connected client,
                // including the admin.
                broadcastGlobal({

                    type: "global_announcement",

                    playerId: ws.playerId,

                    displayName: ws.displayName,

                    text: cleanAnnouncement,

                    timestamp: Date.now()

                });

                return;
            }

            //================================================
            // ROOM ANNOUNCEMENT
            //
            // ;announce Hello this server
            //================================================

            if (
                lowerCommand === ";announce" ||
                lowerCommand.startsWith(";announce ")
            ) {

                const announcement = commandString
                    .slice(9)
                    .trim();

                if (!announcement) {

                    send(ws, {
                        type: "error",
                        message: "Announcement text is empty."
                    });

                    return;
                }

                const cleanAnnouncement =
                    announcement.slice(0, 300);

                // Sends to everyone in the current room,
                // including the admin.
                broadcast(ws.roomId, {

                    type: "announcement",

                    playerId: ws.playerId,

                    displayName: ws.displayName,

                    text: cleanAnnouncement,

                    timestamp: Date.now()

                });

                return;
            }

            //================================================
            // BAN
            //
            // ;ban PlayerName
            //================================================

            if (
                lowerCommand === ";ban" ||
                lowerCommand.startsWith(";ban ")
            ) {

                const targetName = commandString
                    .slice(4)
                    .trim();

                if (!targetName) {

                    send(ws, {
                        type: "error",
                        message: "Player name is required."
                    });

                    return;
                }

                const target =
                    findPlayerInRoom(
                        room,
                        targetName
                    );

                if (!target) {

                    send(ws, {
                        type: "error",
                        message: "Player not found in this room."
                    });

                    return;
                }

                room.bannedPlayerIds.add(
                    String(target.playerId)
                );

                // Sync ban command to clients.
                broadcast(ws.roomId, {

                    type: "admin_sync",

                    commandString:
                        commandString.slice(0, 300),

                    timestamp: Date.now()

                });

                return;
            }

            //================================================
            // OTHER ADMIN COMMANDS
            //================================================

            broadcast(ws.roomId, {

                type: "admin_sync",

                commandString:
                    commandString.slice(0, 300),

                timestamp: Date.now()

            });

            return;
        }

        //==================================================
        // PING
        //==================================================

        if (data.type === "ping") {

            send(ws, {
                type: "pong",
                timestamp: Date.now()
            });

            return;
        }
    });

    //======================================================
    // CLOSE
    //======================================================

    ws.on("close", () => {
        removeClientFromRoom(ws);
    });

    //======================================================
    // ERROR
    //======================================================

    ws.on("error", () => {
        removeClientFromRoom(ws);
    });
});

//==========================================================
// HEARTBEAT
//==========================================================

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

//==========================================================
// SHUTDOWN
//==========================================================

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

//==========================================================
// START
//==========================================================

server.listen(PORT, "0.0.0.0", () => {

    console.log(
        `Roblox Chat Relay running on port ${PORT}`
    );

});
