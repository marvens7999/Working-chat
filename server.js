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

const MAX_COMMAND_LENGTH = 300;
const MAX_ANNOUNCEMENT_LENGTH = 300;

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
    if (
        ws &&
        ws.readyState === WebSocket.OPEN
    ) {
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

    if (!targetName) {
        return null;
    }

    // Exact match first
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

    // Partial display-name match
    for (const client of room.clients) {
        const displayName = String(
            client.displayName || ""
        ).toLowerCase();

        if (
            displayName.startsWith(targetName)
        ) {
            return client;
        }
    }

    return null;
}

//==========================================================
// SUPPORTED ADMIN COMMANDS
//==========================================================
//
// These commands are supported by the ZERO system:
//
// CLIENT-SIDE EFFECTS VIA admin_sync:
// ;hl
// ;unhl
// ;title
// ;untitle
// ;staff
// ;unstaff
//
// SERVER-SIDE:
// ;ban
// ;announce
// ;gannounce
// ;globalannounce
//
//==========================================================

const CLIENT_ADMIN_COMMANDS = new Set([
    "hl",
    "unhl",
    "title",
    "untitle",
    "staff",
    "unstaff"
]);

const SERVER_ADMIN_COMMANDS = new Set([
    "ban",
    "announce",
    "gannounce",
    "globalannounce"
]);

//==========================================================
// GET COMMAND NAME
//==========================================================

function getCommandName(commandString) {
    const firstWord = String(commandString || "")
        .trim()
        .split(/\s+/)[0]
        .toLowerCase();

    return firstWord.startsWith(";")
        ? firstWord.slice(1)
        : firstWord;
}

//==========================================================
// HTTP
//==========================================================

app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "ZERO CHAT Relay",
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
            data = JSON.parse(
                raw.toString()
            );
        } catch {
            send(ws, {
                type: "error",
                message: "Invalid JSON."
            });

            return;
        }

        if (
            !data ||
            typeof data !== "object"
        ) {
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

            if (
                !roomId ||
                roomId.length > 200
            ) {
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
            if (
                room.bannedPlayerIds.has(
                    playerId
                )
            ) {
                send(ws, {
                    type: "error",
                    message:
                        "You are banned from this chat room."
                });

                return;
            }

            // Remove previous room connection
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

        if (
            room.bannedPlayerIds.has(
                String(ws.playerId)
            )
        ) {
            return;
        }

        //==================================================
        // NORMAL CHAT
        //==================================================

        if (data.type === "chat") {

            const text = String(
                data.text || ""
            ).trim();

            if (!text) {
                return;
            }

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

            // Server-side permission check
            if (!isAdmin(ws)) {

                send(ws, {
                    type: "error",
                    message:
                        "Unauthorized admin command."
                });

                return;
            }

            let commandString = String(
                data.commandString || ""
            ).trim();

            if (!commandString) {
                return;
            }

            commandString =
                commandString.slice(
                    0,
                    MAX_COMMAND_LENGTH
                );

            if (
                !commandString.startsWith(";")
            ) {
                send(ws, {
                    type: "error",
                    message:
                        "Admin commands must start with ;"
                });

                return;
            }

            const commandName =
                getCommandName(commandString);

            //================================================
            // CLIENT-SIDE COMMANDS
            //================================================
            //
            // These are sent to all clients in the
            // current room. The ZERO CHAT Lua client
            // executes:
            //
            // ;hl
            // ;unhl
            // ;title
            // ;untitle
            // ;staff
            // ;unstaff
            //
            //================================================

            if (
                CLIENT_ADMIN_COMMANDS.has(
                    commandName
                )
            ) {

                broadcast(ws.roomId, {
                    type: "admin_sync",
                    commandString:
                        commandString,
                    timestamp: Date.now()
                });

                return;
            }

            //================================================
            // GLOBAL ANNOUNCEMENT
            //================================================

            if (
                commandName === "gannounce" ||
                commandName === "globalannounce"
            ) {

                let announcement;

                if (
                    commandName === "gannounce"
                ) {
                    announcement =
                        commandString
                            .slice(
                                ";gannounce".length
                            )
                            .trim();
                } else {
                    announcement =
                        commandString
                            .slice(
                                ";globalannounce".length
                            )
                            .trim();
                }

                if (!announcement) {

                    send(ws, {
                        type: "error",
                        message:
                            "Global announcement text is empty."
                    });

                    return;
                }

                announcement =
                    announcement.slice(
                        0,
                        MAX_ANNOUNCEMENT_LENGTH
                    );

                broadcastGlobal({
                    type:
                        "global_announcement",

                    playerId:
                        ws.playerId,

                    displayName:
                        ws.displayName,

                    text:
                        announcement,

                    timestamp:
                        Date.now()
                });

                return;
            }

            //================================================
            // CURRENT SERVER ANNOUNCEMENT
            //================================================

            if (
                commandName === "announce"
            ) {

                const announcement =
                    commandString
                        .slice(
                            ";announce".length
                        )
                        .trim();

                if (!announcement) {

                    send(ws, {
                        type: "error",
                        message:
                            "Announcement text is empty."
                    });

                    return;
                }

                const cleanAnnouncement =
                    announcement.slice(
                        0,
                        MAX_ANNOUNCEMENT_LENGTH
                    );

                broadcast(ws.roomId, {

                    type:
                        "announcement",

                    playerId:
                        ws.playerId,

                    displayName:
                        ws.displayName,

                    text:
                        cleanAnnouncement,

                    timestamp:
                        Date.now()
                });

                return;
            }

            //================================================
            // BAN
            //================================================

            if (
                commandName === "ban"
            ) {

                const targetName =
                    commandString
                        .slice(";ban".length)
                        .trim();

                if (!targetName) {

                    send(ws, {
                        type: "error",
                        message:
                            "Player name is required."
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
                        message:
                            "Player not found in this room."
                    });

                    return;
                }

                // Do not allow the admin to ban
                // their own account.
                if (
                    String(target.playerId) ===
                    ADMIN_USER_ID
                ) {

                    send(ws, {
                        type: "error",
                        message:
                            "You cannot ban the admin account."
                    });

                    return;
                }

                const targetPlayerId =
                    String(
                        target.playerId
                    );

                room.bannedPlayerIds.add(
                    targetPlayerId
                );

                // Tell all clients to execute the
                // client-side ban behavior.
                broadcast(ws.roomId, {

                    type:
                        "admin_sync",

                    commandString:
                        commandString,

                    timestamp:
                        Date.now()
                });

                // Tell the target directly.
                send(target, {
                    type: "error",
                    message:
                        "You have been banned from this chat room."
                });

                // Remove target from this room.
                try {
                    target.close(
                        1008,
                        "Banned from room"
                    );
                } catch {}

                return;
            }

            //================================================
            // UNKNOWN COMMAND
            //================================================

            send(ws, {
                type: "error",
                message:
                    `Unknown admin command: ;${commandName}`
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

            try {
                ws.terminate();
            } catch {}

            continue;
        }

        ws.isAlive = false;

        try {
            ws.ping();
        } catch {
            try {
                ws.terminate();
            } catch {}
        }
    }

}, 30000);

//==========================================================
// SHUTDOWN
//==========================================================

function shutdown() {

    clearInterval(
        heartbeatInterval
    );

    for (const ws of wss.clients) {

        try {
            ws.close();
        } catch {}
    }

    server.close(() => {
        process.exit(0);
    });
}

process.on(
    "SIGTERM",
    shutdown
);

process.on(
    "SIGINT",
    shutdown
);

//==========================================================
// START
//==========================================================

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `ZERO CHAT Relay running on port ${PORT}`
        );

        console.log(
            "Supported client commands: " +
            ";hl ;unhl ;title ;untitle ;staff ;unstaff"
        );

        console.log(
            "Supported server commands: " +
            ";ban ;announce ;gannounce ;globalannounce"
        );
    }
);
