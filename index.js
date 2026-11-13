import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
dotenv.config();

let admins = process.env.ADMINS || "U08EMT46G3V";
admins = admins.split(";");
console.log("Set admin list", admins)

let banned = [];

const app = express();
app.set("trust proxy", "loopback");
// /demoFrame carries a JPEG in its JSON body, so it gets its own, larger limit (see below).
const parseJson = express.json();
app.use((req, res, next) => (req.path === "/demoFrame" ? next() : parseJson(req, res, next)));
app.use(cors({
    origin: [
        "https://symmetrical-doodle-69qgr7v97j76f59j7-5173.app.github.dev",
        "https://jumbotron.hackclub.com",
        ...(process.env.EXTRA_ORIGINS ? process.env.EXTRA_ORIGINS.split(";") : [])
    ],
    methods: [
        "POST", "GET"
    ],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));

let clientID = "e86d4d7eec9c546e6c4700388d4fea7f";

// tokens[code] = { name, slack, password, cityName?, bridge?, sources?, screenKey? }
//   `bridge` is the single source of truth for merges: a bridged event points at its root.
//   `sources` (root only) is a derived list of member Slack IDs, kept for the admin JSON export.
//   `screenKey` lets paired venue computers run this event's big screen without the organizer's
//   password (see "Screen pairing").
let tokens = {};
let packets = {};
let sessions = {};               // participant SSE streams, keyed by the code they connected with
// Invites to organize an event, by Slack ID: the invitee may not have signed in yet, so there
// may be no event to point at. It shows up on their console whenever they do. `from` is always
// the event's root, whichever of its organizers sent it.
let mergeInvites = new Map();    // `${hostCode}|${slack}` -> { from, slack, createdAt }
let pairCodes = new Map();       // short-lived screen pairing code -> { code, expires }
let orgStreams = new Map();      // organizer code -> Set<res> (the /orgStream SSE feeds)
// Demo time (participant screenshare), keyed by the root event's code: an event's organizers
// share one big screen and one queue.
//   demos.get(code) = { enabled, board, screenCode, screen: res|null, presenter: entry|null, queue: [entry] }
//   entry = { id, who, name, slack, token, res, timer, pickTimer, picked }
//   `board` shows the announcement and up next on the big screen; off, it only carries demos.
let demos = new Map();
// Events whose big screen shows harpa (hackclub/harpa, embedded). Keyed by root code, like demos.
let harpaOn = new Set();

function codeGen(token) {
    let code = randomGen();
    tokens[code] = token;
    packets[code] = null;
    return code;
}

function randomGen() {
    let code = "";
    for (let i = 0; i <= 3; i++) {
        code += Math.floor(Math.random() * 9) + 1;
    }
    if (tokens[code]) {
        return randomGen();
    }
    return code;
}

function tokenLog(slack, name) {
    return slack + "~" + name;
}

function logAs(code, ...msg) {
    const t = tokens[code];
    console.log(t ? tokenLog(t.slack, t.name) : `[${code}]`, ...msg);
}

function isBanned(slack) {
    return banned.indexOf(slack) != -1;
}

// Looks up an event by a caller-supplied code. Only own keys count: a bare `tokens[code]`
// would resolve "constructor" / "__proto__" to Object.prototype members.
function getToken(code) {
    code = String(code ?? "");
    return code && Object.hasOwn(tokens, code) ? tokens[code] : undefined;
}

function safeEqual(a, b) {
    if (typeof a !== "string" || !a) return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Checks an events object (admin import or seed file) before it replaces the live one.
// Returns an error string, or null when every entry is usable.
function validateEvents(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        return "Events must be a JSON object keyed by event code";
    }
    for (const [code, t] of Object.entries(obj)) {
        if (!t || typeof t !== "object" || Array.isArray(t)) {
            return `Event ${code} must be an object`;
        }
        for (const field of ["name", "slack", "password"]) {
            if (typeof t[field] !== "string" || !t[field]) {
                return `Event ${code} is missing a "${field}" string`;
            }
        }
        if (t.bridge != null && typeof t.bridge !== "string") {
            return `Event ${code} has a non-string "bridge"`;
        }
        if (t.cityName != null && typeof t.cityName !== "string") {
            return `Event ${code} has a non-string "cityName"`;
        }
    }
    return null;
}

// Validates code/password from the query (GET) or body (POST).
// Sends the error response itself and returns null on failure, otherwise returns the code.
function authOrganizer(req, res) {
    const src = (req.method === "GET" ? req.query : req.body) || {};
    const code = src.code != null ? String(src.code) : "";
    const password = src.password;
    if (!code || !password) {
        res.status(400).json({ error: "Missing credentials" });
        return null;
    }
    const token = getToken(code);
    if (!token || !safeEqual(token.password, password)) {
        res.status(401).json({ error: "Invalid event code or password" });
        return null;
    }
    if (isBanned(token.slack)) {
        res.status(401).json({ error: "Banned user" });
        return null;
    }
    return code;
}

// Like authOrganizer, but a paired big screen may also sign in with { code, screenKey }.
// Only the big screen's own endpoints accept it.
function authScreen(req, res) {
    const body = req.body || {};
    if (body.password != null || body.screenKey == null) return authOrganizer(req, res);
    const code = body.code != null ? String(body.code) : "";
    const token = getToken(code);
    if (!token || !token.screenKey || !safeEqual(token.screenKey, body.screenKey)) {
        res.status(401).json({ error: "This screen isn't paired with an event anymore" });
        return null;
    }
    if (isBanned(token.slack)) {
        res.status(401).json({ error: "Banned user" });
        return null;
    }
    return code;
}

// The event an organizer acts on: their own, or the one they help organize. Big screen, demo
// time and harpa are per event, so their endpoints use this.
// `req.actor` keeps who did it, for the logs.
function authEvent(req, res) {
    const code = authOrganizer(req, res);
    req.actor = code;
    return code == null ? null : getRootCode(code);
}

function authEventScreen(req, res) {
    const code = authScreen(req, res);
    req.actor = code;
    return code == null ? null : getRootCode(code);
}

// An attendee-supplied event code, resolved to the event it shows.
function rootOf(raw) {
    const code = String(raw ?? "");
    return getToken(code) ? getRootCode(code) : code;
}

function authAdmin(req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return null;
    if (admins.indexOf(tokens[code].slack) == -1) {
        res.status(401).json({ error: "Admin permissions not present" });
        return null;
    }
    return code;
}

// --- SSE plumbing ---

function openSSE(res) {
    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    });
    res.flushHeaders();
    res.write("retry: 5000\n\n");
}

function sseWrite(res, payload) {
    try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {}
}

function sseEnd(res, payload) {
    if (payload) sseWrite(res, payload);
    try {
        res.end();
    } catch (e) {}
}

// Reverse proxies drop idle connections (~60-100s); a comment line keeps every stream alive.
setInterval(() => {
    for (const list of Object.values(sessions)) {
        for (const res of list) {
            try { res.write(": ping\n\n"); } catch (e) {}
        }
    }
    for (const set of orgStreams.values()) {
        for (const res of set) {
            try { res.write(": ping\n\n"); } catch (e) {}
        }
    }
    for (const d of demos.values()) {
        for (const res of [d.screen, d.presenter && d.presenter.res]) {
            if (!res) continue;
            try { res.write(": ping\n\n"); } catch (e) {}
        }
    }
}, 25000).unref();

// --- Merge model ---

function getRootCode(code) {
    const t = getToken(code);
    const bridge = t && t.bridge;
    return bridge && getToken(bridge) ? bridge : code;
}

function getMembers(root) {
    return Object.keys(tokens).filter(c => tokens[c].bridge === root);
}

function groupCodes(root) {
    return [root, ...getMembers(root)];
}

function syncSources(root) {
    if (!tokens[root]) return;
    tokens[root].sources = getMembers(root).map(c => tokens[c].slack);
}

// Repairs a tokens object (e.g. after an admin import) so every bridge points at a live root
// and merges are exactly one level deep: dangling bridges are dropped, chains are flattened to
// their ultimate root, and cycles are broken.
function normalizeMerges() {
    for (const [code, t] of Object.entries(tokens)) {
        if (t.bridge && (!getToken(t.bridge) || t.bridge === code)) delete t.bridge;
    }
    for (const t of Object.values(tokens)) {
        if (!t.bridge) continue;
        const seen = new Set();
        let root = t.bridge;
        while (tokens[root].bridge && !seen.has(root)) {
            seen.add(root);
            root = tokens[root].bridge;
        }
        if (tokens[root].bridge) delete t.bridge; // cycle
        else t.bridge = root;
    }
    for (const [code, t] of Object.entries(tokens)) {
        if (t.bridge) delete t.sources;
        else syncSources(code);
    }
}

function publicEvent(code) {
    const t = tokens[code];
    if (!t) return null;
    return { code, name: t.name, slack: t.slack, cityName: t.cityName || null };
}

function eventBySlack(slack) {
    const found = Object.entries(tokens).find(([, t]) => t.slack === slack);
    return found ? found[0] : null;
}

const inviteKey = (host, slack) => `${host}|${slack}`;
const invitesFrom = (host) => [...mergeInvites.values()].filter(i => i.from === host);
const invitesTo = (slack) => [...mergeInvites.values()].filter(i => i.slack === slack);

// Removes one invite and tells both sides (the invitee only if they have an event).
function dropInvite(inv, hostReason, inviteeReason) {
    if (!mergeInvites.delete(inviteKey(inv.from, inv.slack))) return;
    if (hostReason) notifyGroup(inv.from, hostReason);
    const invitee = eventBySlack(inv.slack);
    if (inviteeReason && invitee) notifyOrg(invitee, inviteeReason);
}

// Everything an organizer's Organizers panel needs, from that organizer's point of view.
// Organizers share one event: the root ("bridged" organizers' own events point at it).
function mergeState(code) {
    const root = getRootCode(code);
    const bridged = root !== code;
    return {
        code,
        role: bridged ? "bridged" : "root",
        root: publicEvent(root),
        members: getMembers(root).map(publicEvent),
        // Invites out from this event, by any of its organizers. `name`/`code` are null until
        // the invitee signs in.
        invitesSent: invitesFrom(root).map(i => {
            const c = eventBySlack(i.slack);
            return { slack: i.slack, name: c ? tokens[c].name : null, code: c, createdAt: i.createdAt };
        }),
        // Invites waiting for this organizer, shown even while bridged or hosting so they know
        // what to undo before accepting.
        invites: invitesTo(tokens[code].slack)
            .filter(i => getToken(i.from))
            .map(i => ({ ...publicEvent(i.from), createdAt: i.createdAt }))
    };
}

function notifyOrg(code, reason) {
    const set = orgStreams.get(code);
    if (!set || !tokens[code]) return;
    const payload = { type: "state", reason, state: mergeState(code) };
    for (const res of set) sseWrite(res, payload);
}

function notifyGroup(root, reason) {
    for (const c of groupCodes(root)) notifyOrg(c, reason);
}

function closeOrgStreams(code, payload) {
    const set = orgStreams.get(code);
    if (!set) return;
    for (const res of set) sseEnd(res, payload);
    orgStreams.delete(code);
}

function participantPayload(code) {
    const root = getRootCode(code);
    return {
        code: root,   // the code to show for joining (an organizer's own code leads here too)
        data: packets[root] ?? null,
        demos: !!(demos.get(root) && demos.get(root).enabled),
        mirror: mirrorState(root),
        cityName: (tokens[root] && tokens[root].cityName) || (tokens[code] && tokens[code].cityName) || null
    };
}

function pushToParticipants(codes) {
    let count = 0;
    for (const c of codes) {
        const list = sessions[c];
        if (!list || list.length == 0) continue;
        const payload = participantPayload(c);
        for (const res of list) sseWrite(res, payload);
        count += list.length;
    }
    return count;
}

// `member` becomes an organizer of `root`'s event.
function mergeInto(root, member) {
    tokens[member].bridge = root;
    delete tokens[member].sources;

    syncSources(root);
    pushToParticipants([member]);

    // The member's own big screen, demo queue and harpa give way to the shared ones. A big
    // screen tab it had open reconnects and comes back as the shared screen.
    closeDemo(member, { type: "moved" });
    harpaOn.delete(member);

    // Invites: the one that brought `member` in (if any) is spent; other events' invites to
    // `member` can't be accepted while it organizes this one; and invites out of `member`'s own
    // event are withdrawn.
    const memberSlack = tokens[member].slack;
    mergeInvites.delete(inviteKey(root, memberSlack));
    for (const inv of invitesTo(memberSlack)) dropInvite(inv, "invite_unavailable", null);
    for (const inv of invitesFrom(member)) dropInvite(inv, null, "invite_cancelled");

    notifyGroup(root, "merged");
}

function unmerge(member, reason) {
    const root = tokens[member] && tokens[member].bridge;
    if (!root) return;
    delete tokens[member].bridge;
    // The departing event goes back to its own content: packets[member] was left alone while
    // it was merged (everything was published to the root), so nothing from the shared event
    // follows it out.
    syncSources(root);
    syncSources(member);
    pushToParticipants([member]);
    // A big screen this organizer opened was the shared one; it reconnects as their own.
    const d = demos.get(root);
    if (d && d.screen && d.screen.openedBy === member) sseEnd(d.screen, { type: "moved" });
    notifyGroup(root, reason);
    notifyOrg(member, reason);
}

// Removes an event entirely (a ban, or its organizer deleting it). Its members become
// standalone roots. `why` is "banned" or "deleted".
function purgeEvent(code, endPayload, why = "banned") {
    for (const inv of invitesFrom(code)) dropInvite(inv, null, "invite_unavailable");
    for (const inv of invitesTo(tokens[code].slack)) dropInvite(inv, "invite_unavailable", null);
    for (const [p, v] of pairCodes) {
        if (v.code === code) pairCodes.delete(p);
    }
    for (const m of getMembers(code)) unmerge(m, why === "deleted" ? "host_deleted" : "host_removed");
    // From the host's side a banned member simply leaves.
    if (tokens[code].bridge) unmerge(code, "member_left");

    for (const res of sessions[code] || []) sseEnd(res, endPayload);
    closeOrgStreams(code, { type: "revoked", reason: why });
    closeDemo(code, { type: "revoked", reason: why });
    harpaOn.delete(code);
    for (const [ticket, v] of streamTickets) {
        if (v.code === code) streamTickets.delete(ticket);
    }
    delete sessions[code];
    delete tokens[code];
    delete packets[code];
}

if (process.env.SEED_FILE) {
    const seeded = JSON.parse(fs.readFileSync(process.env.SEED_FILE, "utf8"));
    const problem = validateEvents(seeded);
    if (problem) {
        console.error(`Refusing SEED_FILE ${process.env.SEED_FILE}: ${problem}`);
        process.exit(1);
    }
    tokens = seeded;
    for (const code of Object.keys(tokens)) {
        sessions[code] = [];
        packets[code] = null;
    }
    normalizeMerges();
    console.log(`Seeded ${Object.keys(tokens).length} events from ${process.env.SEED_FILE}`);
}

// --- Express Routes ---

// Trades a Hack Club Auth authorization code for the account's identity. Throws an Error with
// `status` (401: auth refused, 502: Hack Club Auth unreachable) and a message for the user.
async function fetchHcaIdentity(code) {
    const fail = (status, message) => Object.assign(new Error(message), { status });
    let response, response2;
    try {
        response = await fetch("https://auth.hackclub.com/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                "client_id": clientID,
                "client_secret": process.env.CLIENT_SECRET,
                "redirect_uri": process.env.REDIRECT,
                "code": code,
                "grant_type": "authorization_code"
            })
        });
        if (!response.ok) throw fail(401, "Initial auth request failed");
        const data = await response.json();

        response2 = await fetch("https://auth.hackclub.com/api/v1/me", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${data.access_token}`,
                "Content-Type": "application/json"
            }
        });
        if (!response2.ok) throw fail(401, "Information request failed");
        const me = await response2.json();
        const identity = me && me.identity;
        if (!identity || typeof identity !== "object") throw fail(401, "Auth response missing identity");
        return identity;
    } catch (e) {
        if (e.status) throw e;
        console.error("Auth provider request failed:", e);
        throw fail(502, "Could not reach Hack Club Auth, try again soon");
    }
}

app.post("/genToken", async function(req, res) {
    const { code } = req.body || {};
    if (!code || typeof code !== "string") {
        return res.status(400).json({ error: "Missing code" });
    }

    let scopes;
    try {
        scopes = await fetchHcaIdentity(code);
    } catch (e) {
        return res.status(e.status || 502).json({ error: e.message });
    }
    if (!scopes || typeof scopes.slack_id !== "string" || !scopes.slack_id) {
        return res.status(401).json({ error: "Auth response missing identity" });
    }
    if (!scopes.ysws_eligible || scopes.verification_status != "verified") {
        return res.status(401).json({ error: "User is not eligible" });
    }

    if (isBanned(scopes.slack_id)) {
        return res.status(401).json({ error: "Banned user" });
    }

    let existing = Object.entries(tokens).find(([c, t]) => t.slack == scopes.slack_id);
    if (existing) {
        let [existingCode, userToken] = existing;
        return res.status(200).json({
            credentials: [existingCode, scopes.slack_id, scopes.first_name, userToken.password],
            sources: userToken.sources || []
        });
    }

    const randarray = new Uint8Array(16);
    crypto.getRandomValues(randarray);
    let cryptoCode = "";
    for (let i = 0; i < randarray.length; i++) {
        cryptoCode += "" + randarray[i];
    }

    let newToken = {};
    newToken.name = scopes.first_name;
    newToken.slack = scopes.slack_id;
    newToken.password = cryptoCode;
    newToken.sources = [];
    const jumbotronCode = codeGen(newToken);
    sessions[jumbotronCode] = [];
    console.log(tokenLog(newToken.slack, newToken.name), `Generated new code ${jumbotronCode}`);

    return res.status(200).json({
        credentials: [jumbotronCode, newToken.slack, newToken.name, newToken.password],
        sources: newToken.sources
    });
});

app.post("/initEvent", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    const { cityName } = req.body;
    if (!cityName || typeof cityName !== "string") {
        return res.status(400).json({ error: "Missing parameter(s)" });
    }

    if (tokens[code].bridge) {
        const host = getToken(tokens[code].bridge);
        return res.status(409).json({ error: `Your event uses ${host ? `${host.name}'s` : "the host's"} name while merged. Only the host can rename it.` });
    }

    tokens[code].cityName = cityName.trim();
    const count = pushToParticipants(groupCodes(code));
    notifyGroup(code, "city_changed");
    logAs(code, `Set ${cityName} as location visible${count ? ` and broadcast to ${count} users` : ""}`);

    return res.status(200).json({ message: `Set ${cityName} as location visible to participants` });
});

// What a packet may carry. `announcement` is the newest announcement, for older attendee tabs.
// `announcementsHidden` keeps the list while organizers have announcements switched off, so
// switching them back on restores it. Attendee views ignore it.
const PACKET_KEYS = ["announcements", "announcement", "announcementsHidden", "event", "file", "youtube", "website"];

function parsePacket(raw) {
    try {
        const p = typeof raw === "string" ? JSON.parse(raw) : raw;
        return p && typeof p === "object" && !Array.isArray(p) ? p : null;
    } catch (e) {
        return null;
    }
}

app.post("/sendPacket", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    const { packet, changed, tab } = req.body;
    if (!packet) {
        return res.status(400).json({ error: "Missing parameter(s)" });
    }

    // Organizers share the root event's content.
    const rootCode = getRootCode(code);

    // With `changed`, only those keys replace what's there, so two organizers publishing
    // different things don't undo each other. Without it (older consoles) the packet replaces all.
    let next = packet;
    let keys = PACKET_KEYS;
    if (Array.isArray(changed)) {
        const incoming = parsePacket(packet);
        if (!incoming) return res.status(400).json({ error: "Packet must be a JSON object" });
        keys = PACKET_KEYS.filter(k => changed.includes(k));
        const merged = parsePacket(packets[rootCode]) || {};
        for (const k of keys) merged[k] = incoming[k] ?? null;
        merged.timestamp = Date.now();
        next = JSON.stringify(merged);
    }
    packets[rootCode] = next;

    const count = pushToParticipants(groupCodes(rootCode));
    // Every organizer console of this event sees the change (`tab` lets the sender skip its echo).
    const push = { type: "packet", data: next, tab: typeof tab === "string" ? tab.slice(0, 64) : null };
    for (const c of groupCodes(rootCode)) {
        for (const s of orgStreams.get(c) || []) sseWrite(s, push);
    }
    logAs(code, `Updated ${Array.isArray(changed) ? keys.join(", ") || "nothing" : "everything"}${count ? ` and broadcast to ${count} users` : ""}`);
    return res.status(200).json({ message: `Updated information${count ? ` and broadcasted to ${count} users` : ""}`, packet: next });
});

app.get("/getPacket", async function (req, res) {
    const code = req.query.code != null ? String(req.query.code) : "";
    if (!code) {
        return res.status(400).json({ error: "Missing event code" });
    }
    if (!getToken(code)) {
        return res.status(400).json({ error: "No event found" });
    }
    if (isBanned(tokens[code].slack)) {
        return res.status(401).json({ error: "Banned user" });
    }

    return res.status(200).json(participantPayload(code));
});

app.get("/getSession", async function(req, res) {
    const code = req.query.code != null ? String(req.query.code) : "";
    if (!code) {
        return res.status(400).json({ error: "No event code provided" });
    }
    if (!getToken(code)) {
        return res.status(400).json({ error: "No event found based on provided code" });
    }
    if (isBanned(tokens[code].slack)) {
        return res.status(401).json({ error: "Banned user" });
    }

    openSSE(res);
    (sessions[code] ??= []).push(res);
    sseWrite(res, participantPayload(code));

    res.on("close", () => {
        if (sessions[code]) sessions[code] = sessions[code].filter(x => x != res);
    });
});

// --- Organizer stream & merges ---
//
// One authenticated SSE feed per organizer tab. Every message is either
//   { type: "state", reason, state }   -> replace the client's merge state wholesale
//   { type: "reset" }                  -> admin replaced the database; re-check credentials
//   { type: "revoked", reason }        -> credentials are no longer valid; sign out
// All merge actions are plain POSTs; their effects arrive back over this feed.

// EventSource can't send a body or headers, so instead of putting the password in the
// stream URL (where proxies log it) the client trades credentials for a single-use ticket
// that expires in seconds, and opens /orgStream?ticket=... with that.
const STREAM_TICKET_TTL = 30 * 1000;
let streamTickets = new Map();   // ticket -> { code, expires }

app.post("/streamTicket", async function (req, res) {
    const code = authScreen(req, res);
    if (code == null) return;
    const now = Date.now();
    for (const [t, v] of streamTickets) {
        if (v.expires <= now) streamTickets.delete(t);
    }
    const ticket = crypto.randomBytes(32).toString("hex");
    // Pin the ticket to this event's identity, not just its code: a purged event's code can be
    // handed to a different organizer within the ticket's lifetime. A ticket bought with a
    // screen key only opens the big screen's stream, and dies with that key.
    const t = tokens[code];
    const screenOnly = req.body.password == null;
    streamTickets.set(ticket, {
        code,
        slack: t.slack,
        secret: screenOnly ? t.screenKey : t.password,
        screenOnly,
        expires: now + STREAM_TICKET_TTL
    });
    return res.status(200).json({ ticket });
});

// Spends a stream ticket. Sends the error response itself and returns null on failure,
// otherwise returns the organizer's code.
function redeemTicket(req, res, { allowScreen = false } = {}) {
    const ticket = req.query.ticket != null ? String(req.query.ticket) : "";
    const entry = ticket ? streamTickets.get(ticket) : undefined;
    if (entry) streamTickets.delete(ticket);
    if (!entry || entry.expires <= Date.now() || (entry.screenOnly && !allowScreen)) {
        res.status(401).json({ error: "Invalid or expired stream ticket" });
        return null;
    }
    const code = entry.code;
    // The event may have been banned, purged and re-issued, or replaced since the ticket was issued.
    const token = getToken(code);
    const secret = token && (entry.screenOnly ? token.screenKey : token.password);
    if (!token || token.slack !== entry.slack || !secret || secret !== entry.secret || isBanned(token.slack)) {
        res.status(401).json({ error: "Invalid event code or password" });
        return null;
    }
    req.screenOnly = entry.screenOnly;
    return code;
}

app.get("/orgStream", async function (req, res) {
    const code = redeemTicket(req, res);
    if (code == null) return;

    openSSE(res);
    if (!orgStreams.has(code)) orgStreams.set(code, new Set());
    orgStreams.get(code).add(res);
    sseWrite(res, { type: "state", reason: "connected", state: mergeState(code) });
    sseWrite(res, { type: "demo", demo: demoState(getRootCode(code)) });
    sseWrite(res, { type: "harpa", harpa: harpaState(getRootCode(code)) });

    res.on("close", () => {
        const set = orgStreams.get(code);
        if (!set) return;
        set.delete(res);
        if (set.size == 0) orgStreams.delete(code);
    });
});

// An organizer deletes their own event: its code, name, content, big screen and invites. Other
// organizers go back to their own events; signing in again starts a fresh event.
app.post("/deleteEvent", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    logAs(code, "Deleted their event");
    purgeEvent(code, { error: "This event has ended" }, "deleted");
    return res.status(200).json({ message: "Event deleted" });
});

app.post("/mergeState", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    return res.status(200).json(mergeState(code));
});

app.post("/unmerge", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;

    if (tokens[code].bridge) {
        // A bridged event can only remove itself.
        const root = tokens[code].bridge;
        unmerge(code, "member_left");
        logAs(code, `Left merge with ${root}`);
        return res.status(200).json(mergeState(code));
    }

    const target = req.body.target != null ? String(req.body.target) : "";
    if (!target || !getToken(target) || tokens[target].bridge !== code) {
        return res.status(404).json({ error: "That event isn't merged into yours" });
    }
    unmerge(target, "member_removed");
    logAs(code, `Removed ${target} from merge`);
    return res.status(200).json(mergeState(code));
});

// --- Merge invites: a host adds organizers by Slack ID ---

const INVITES_MAX = 25;

app.post("/mergeInvite", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    const slack = req.body.slack != null ? String(req.body.slack).trim().toUpperCase() : "";

    if (!/^[UW][A-Z0-9]{6,15}$/.test(slack)) {
        return res.status(400).json({ error: "That doesn't look like a Slack member ID. They start with U, like U0123ABCD." });
    }
    if (slack === tokens[code].slack) {
        return res.status(400).json({ error: "That's your own Slack ID." });
    }
    if (isBanned(slack)) {
        return res.status(403).json({ error: "You can't add that person." });
    }
    const root = getRootCode(code);
    const target = eventBySlack(slack);
    if (target && getRootCode(target) === root) {
        return res.status(409).json({ error: `${tokens[target].name} is already an organizer here.` });
    }
    if (mergeInvites.has(inviteKey(root, slack))) {
        return res.status(200).json(mergeState(code));
    }
    if (invitesFrom(root).length >= INVITES_MAX) {
        return res.status(409).json({ error: `You can have up to ${INVITES_MAX} invites waiting. Cancel some first.` });
    }

    mergeInvites.set(inviteKey(root, slack), { from: root, slack, createdAt: Date.now() });
    notifyGroup(root, "invite_sent");
    if (target) notifyOrg(target, "invite_received");
    logAs(code, `Invited ${slack} to organize ${root}`);
    return res.status(200).json(mergeState(code));
});

app.post("/cancelMergeInvite", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    const slack = req.body.slack != null ? String(req.body.slack).trim().toUpperCase() : "";
    const root = getRootCode(code);
    const inv = mergeInvites.get(inviteKey(root, slack));
    if (!inv) {
        return res.status(404).json({ error: "That invite no longer exists." });
    }
    dropInvite(inv, null, "invite_cancelled");
    notifyGroup(root, "invite_withdrawn");
    logAs(code, `Cancelled invite to ${slack}`);
    return res.status(200).json(mergeState(code));
});

app.post("/respondMergeInvite", async function (req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;
    const host = req.body.host != null ? String(req.body.host) : "";
    const { accept } = req.body;
    if (!host || typeof accept !== "boolean") {
        return res.status(400).json({ error: "Missing host or accept flag" });
    }

    const inv = mergeInvites.get(inviteKey(host, tokens[code].slack));
    if (!inv) {
        return res.status(404).json({ error: "This invite no longer exists. It may have been cancelled." });
    }

    if (!accept) {
        dropInvite(inv, null, null);
        notifyGroup(host, "invite_declined");
        logAs(code, `Declined invite from ${host}`);
        return res.status(200).json(mergeState(code));
    }

    const hostToken = getToken(host);
    if (!hostToken || hostToken.bridge || isBanned(hostToken.slack)) {
        dropInvite(inv, "invite_unavailable", null);
        return res.status(409).json({ error: "This invite is no longer valid." });
    }
    if (tokens[code].bridge) {
        return res.status(409).json({ error: "You already organize another event. Leave it first." });
    }
    if (getMembers(code).length > 0) {
        return res.status(409).json({ error: "Other organizers are on your event. Remove them before joining another." });
    }

    mergeInto(host, code);
    logAs(code, `Accepted invite from ${host}`);
    return res.status(200).json(mergeState(code));
});

// --- Demo time (participant screenshare) ---
//
// The video itself travels peer-to-peer over WebRTC, presenter laptop -> projector tab. This
// server only decides who may present and relays the few KB of handshake text between them:
//   projector tab  : organizer credentials -> /streamTicket -> /screenStream (SSE down), /demoSignal (up)
//   presenter      : screen code from the projector -> /demoJoin -> /demoStream (SSE down), /demoSignal (up)
// Every organizer console also gets { type: "demo", demo } on its /orgStream.

const DEMO_GRACE = 15 * 1000;          // a presenter whose stream dropped may reconnect this long
const DEMO_PENDING_TTL = 90 * 1000;    // time to pick a window after the code was accepted
const DEMO_SIGNAL_MAX = 32 * 1024;
const DEMO_NAME_MAX = 40;

// STUN finds a direct path; venues that isolate wifi clients need a TURN relay as well.
// ICE_SERVERS is a JSON array of RTCIceServer objects.
let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
if (process.env.ICE_SERVERS) {
    try {
        const parsed = JSON.parse(process.env.ICE_SERVERS);
        if (Array.isArray(parsed)) iceServers = parsed;
    } catch (e) {
        console.error("Ignoring ICE_SERVERS: not valid JSON");
    }
}

function getDemo(code) {
    let d = demos.get(code);
    if (!d) {
        d = { enabled: false, board: true, mirror: false, frame: null, screenCode: null, screen: null, presenter: null, queue: [], viewers: new Map() };
        demos.set(code, d);
    }
    return d;
}

function newScreenCode() {
    return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

// A presenter is "live" once they've picked a window and their feed is connected.
const isLive = (p) => !!(p && p.picked && p.res);

// What organizers and the projector see. Tokens never leave this file.
function demoState(code) {
    const d = demos.get(code);
    const paired = !!(tokens[code] && tokens[code].screenKey);
    if (!d) return { enabled: false, board: true, mirror: false, screenCode: null, screenOpen: false, paired, presenter: null, queue: [] };
    const p = d.presenter;
    return {
        paired,   // some computer has been paired: the console offers to sign them out
        enabled: d.enabled,
        board: d.board,
        mirror: d.mirror,
        screenCode: d.enabled ? d.screenCode : null,
        screenOpen: !!d.screen,
        presenter: p ? { id: p.id, name: p.name, slack: p.slack, picked: p.picked, live: isLive(p) } : null,
        queue: d.queue.map(q => ({ id: q.id, name: q.name, slack: q.slack, connected: !!q.res }))
    };
}

function notifyDemo(code) {
    const payload = { type: "demo", demo: demoState(code) };
    for (const c of groupCodes(code)) {
        for (const res of orgStreams.get(c) || []) sseWrite(res, payload);
    }
    const d = demos.get(code);
    if (!d) return;
    if (d.screen) sseWrite(d.screen, payload);
    // Everyone waiting sees their place in line move.
    d.queue.forEach((q, i) => {
        if (q.res) sseWrite(q.res, { type: "queued", position: i + 1 });
    });
}

function endPresenter(code, reason) {
    const d = demos.get(code);
    const p = d && d.presenter;
    if (!p) return;
    // Cleared before the stream is ended: ending it fires the stream's own close handler.
    d.presenter = null;
    clearTimeout(p.timer);
    clearTimeout(p.pickTimer);
    if (p.res) sseEnd(p.res, { type: "ended", reason });
    clearFrame(code);
    dropViewers(code, "presenter_changed");
    notifyDemo(code);
}

function dropQueued(code, entry, reason) {
    const d = demos.get(code);
    if (!d) return;
    const i = d.queue.indexOf(entry);
    if (i === -1) return;
    d.queue.splice(i, 1);
    clearTimeout(entry.timer);
    if (entry.res) sseEnd(entry.res, { type: "ended", reason });
    notifyDemo(code);
}

function clearQueue(code, reason) {
    const d = demos.get(code);
    if (!d) return;
    const waiting = d.queue;
    d.queue = [];
    for (const q of waiting) {
        clearTimeout(q.timer);
        if (q.res) sseEnd(q.res, { type: "ended", reason });
    }
    notifyDemo(code);
}

function closeDemo(code, payload) {
    const d = demos.get(code);
    if (!d) return;
    endPresenter(code, "closed");
    clearQueue(code, "closed");
    demos.delete(code);
    if (d.screen) sseEnd(d.screen, payload);
}

// Approving someone while `current` is approved hands them the screen: the organizer's click is
// the decision, so `current` is ended (they're told the screen went to someone else).
// Return "reject" instead to keep `current` and tell the organizer to stop them first.
function approveWhileBusy(current) {
    return "replace";
}

// Wrong screen codes, per caller and per event, within the last minute. Four digits are only
// safe if guessing is slow.
const DEMO_FAIL_WINDOW = 60 * 1000;
let demoFailures = new Map();   // key -> [timestamps]

function recentFailures(key) {
    const now = Date.now();
    const list = (demoFailures.get(key) || []).filter(t => now - t < DEMO_FAIL_WINDOW);
    if (list.length) demoFailures.set(key, list);
    else demoFailures.delete(key);
    return list;
}

setInterval(() => {
    for (const key of [...demoFailures.keys()]) recentFailures(key);
}, DEMO_FAIL_WINDOW).unref();

function demoPresenter(code, token) {
    const d = demos.get(String(code ?? ""));
    const p = d && d.presenter;
    return p && safeEqual(p.token, token) ? p : null;
}

function demoQueued(code, token) {
    const d = demos.get(String(code ?? ""));
    return (d && d.queue.find(q => safeEqual(q.token, token))) || null;
}

function validSignal(signal) {
    if (!signal || typeof signal !== "object" || Array.isArray(signal)) return false;
    try {
        return JSON.stringify(signal).length <= DEMO_SIGNAL_MAX;
    } catch (e) {
        return false;
    }
}

// --- Presenters ---
//
// Presenters aren't signed in: they type a name, and the queue shows it as typed (unverified).
// `device` is a random id the browser keeps, so a reload doesn't add a second queue entry.

function cleanName(raw) {
    return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, DEMO_NAME_MAX) : "";
}

// Signs a banned person out and takes them off every big screen and queue.
function kickAttendee(slack) {
    for (const [code, d] of demos) {
        if (d.presenter && d.presenter.slack === slack) endPresenter(code, "stopped");
        for (const q of d.queue.filter(q => q.slack === slack)) dropQueued(code, q, "removed");
    }
}

app.post("/demoState", async function (req, res) {
    const code = authEvent(req, res);
    if (code == null) return;
    return res.status(200).json({ demo: demoState(code) });
});

app.post("/demoSet", async function (req, res) {
    const code = authEvent(req, res);
    if (code == null) return;
    const { enabled, board, mirror } = req.body;
    if ((enabled != null && typeof enabled !== "boolean") || (board != null && typeof board !== "boolean") ||
        (mirror != null && typeof mirror !== "boolean") || (enabled == null && board == null && mirror == null)) {
        return res.status(400).json({ error: "Send enabled, board and/or mirror as true or false" });
    }

    const d = getDemo(code);
    if (mirror != null && d.mirror !== mirror) {
        d.mirror = mirror;
        if (!mirror) {
            clearFrame(code);
            dropViewers(code, "mirror_off");
        }
        notifyDemo(code);
        logAs(req.actor || code, `Turned the attendee mirror ${mirror ? "on" : "off"}`);
    }
    if (board != null && d.board !== board) {
        d.board = board;
        notifyDemo(code);
        logAs(req.actor || code, `Turned the big screen board ${board ? "on" : "off"}`);
    }
    if (enabled != null && d.enabled !== enabled) {
        d.enabled = enabled;
        // One code for the whole event: organizers pick who presents from the queue, so the room
        // only has to learn it once. demoState() hides it while demo time is off.
        d.screenCode ??= newScreenCode();
        if (!enabled) {
            endPresenter(code, "demos_off");
            clearQueue(code, "demos_off");
        }
        pushToParticipants(groupCodes(code));
        notifyDemo(code);
        logAs(req.actor || code, `Turned demo time ${enabled ? "on" : "off"}`);
    }
    return res.status(200).json({ demo: demoState(code) });
});

// --- Demo mirror: the presenter's screen on attendees' devices ---
//
// The video only travels presenter -> projector (WebRTC, one viewer). When an organizer turns
// `mirror` on, the projector also posts a JPEG snapshot of it to /demoFrame a couple of times a
// second (only when the picture changed). Attendees on this event's own code are told the frame
// number over /getSession (`mirror: { name, n }`) and load the image from GET /demoFrame. Plain
// images work on every phone and network, where venue wifi often blocks device-to-device video.

const FRAME_MAX = 400 * 1024;          // decoded JPEG bytes
const FRAME_MIN_GAP = 250;             // ms between accepted frames

function mirrorState(code) {
    const d = demos.get(code);
    if (!d || !d.enabled || !d.mirror || !d.frame || !isLive(d.presenter)) return null;
    return { name: d.presenter.name, n: d.frame.n };
}

function clearFrame(code) {
    const d = demos.get(code);
    if (!d || !d.frame) return;
    d.frame = null;
    pushToParticipants(groupCodes(code));
}

app.post("/demoFrame", express.json({ limit: "600kb" }), async function (req, res) {
    const code = authEventScreen(req, res);
    if (code == null) return;
    const d = demos.get(code);
    if (!d || !d.enabled || !d.mirror || !isLive(d.presenter)) {
        return res.status(409).json({ error: "Not mirroring right now" });
    }
    const frame = req.body && req.body.frame;
    if (typeof frame !== "string" || !frame.startsWith("data:image/jpeg;base64,")) {
        return res.status(400).json({ error: "Send frame as a JPEG data URL" });
    }
    const buf = Buffer.from(frame.slice("data:image/jpeg;base64,".length), "base64");
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf.length > FRAME_MAX) {
        return res.status(400).json({ error: "That frame isn't a JPEG under 400 KB" });
    }
    const now = Date.now();
    if (d.frame && now - d.frame.at < FRAME_MIN_GAP) return res.status(429).json({ error: "Too many frames" });
    d.frame = { n: (d.frame ? d.frame.n : 0) + 1, buf, at: now };
    pushToParticipants(groupCodes(code));
    return res.status(200).json({ n: d.frame.n });
});

// Public, like /getSession: anyone with the event code can watch the big screen's demo.
app.get("/demoFrame", async function (req, res) {
    const code = req.query.code != null ? rootOf(req.query.code) : "";
    const d = getToken(code) ? demos.get(code) : null;
    if (!mirrorState(code)) return res.status(404).json({ error: "Nothing is being mirrored" });
    // The URL carries the frame number, so any one frame never changes.
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=60" });
    return res.status(200).send(d.frame.buf);
});

// --- Live mirror: real video from the projector tab to attendees ---
//
// Attendees who can reach the projector tab get the presenter's screen as live WebRTC video,
// straight from the projector laptop (no media server, no keys). Each watcher opens
// /mirrorStream (SSE down) and posts its handshake to /mirrorSignal (up); the projector tab
// answers through /demoSignal with `viewer` set. The projector uploads one copy per watcher,
// so the number is capped; anyone past the cap, or whose connection fails, keeps using the
// JPEG snapshots above.

const VIEWER_MAX = 15;

function mirrorLive(d) {
    return !!(d && d.enabled && d.mirror && d.screen && isLive(d.presenter));
}

function dropViewer(code, id, reason) {
    const d = demos.get(code);
    const v = d && d.viewers.get(id);
    if (!v) return;
    d.viewers.delete(id);
    if (reason) sseEnd(v, { type: "ended", reason });
    if (d.screen) sseWrite(d.screen, { type: "viewerLeave", viewer: id });
}

function dropViewers(code, reason) {
    const d = demos.get(code);
    if (!d) return;
    for (const id of [...d.viewers.keys()]) dropViewer(code, id, reason);
}

const validViewer = (id) => typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id);

app.get("/mirrorStream", async function (req, res) {
    const code = req.query.code != null ? rootOf(req.query.code) : "";
    const viewer = req.query.viewer;
    if (!getToken(code) || !validViewer(viewer)) return res.status(400).json({ error: "Bad request" });
    const d = demos.get(code);
    if (!mirrorLive(d)) return res.status(409).json({ error: "Nothing is being mirrored" });

    openSSE(res);
    const previous = d.viewers.get(viewer);
    if (!previous && d.viewers.size >= VIEWER_MAX) {
        return sseEnd(res, { type: "full" });
    }
    d.viewers.set(viewer, res);
    if (previous) sseEnd(previous);
    sseWrite(res, { type: "hello", iceServers });
    sseWrite(d.screen, { type: "viewerJoin", viewer });

    res.on("close", () => {
        const now = demos.get(code);
        if (now && now.viewers.get(viewer) === res) dropViewer(code, viewer);
    });
});

// A watcher's handshake message (their offer or ICE candidates) on its way to the projector.
app.post("/mirrorSignal", async function (req, res) {
    const body = req.body || {};
    const code = body.code != null ? rootOf(body.code) : "";
    const d = getToken(code) ? demos.get(code) : null;
    if (!validViewer(body.viewer) || !validSignal(body.signal)) return res.status(400).json({ error: "Invalid signal" });
    if (!d || !d.viewers.has(body.viewer) || !mirrorLive(d)) return res.status(409).json({ delivered: false });
    sseWrite(d.screen, { type: "viewerSignal", viewer: body.viewer, signal: body.signal });
    return res.status(200).json({ delivered: true });
});

app.post("/demoStop", async function (req, res) {
    const code = authEvent(req, res);
    if (code == null) return;
    const d = demos.get(code);
    if (d && d.presenter) {
        logAs(req.actor || code, `Stopped ${d.presenter.name}'s screenshare`);
        endPresenter(code, "stopped");
    }
    return res.status(200).json({ demo: demoState(code) });
});

// Hands the big screen to someone in the queue. They still have to pick a window.
app.post("/demoApprove", async function (req, res) {
    const code = authEvent(req, res);
    if (code == null) return;
    const d = demos.get(code);
    const entry = d && d.queue.find(q => q.id === String(req.body.id ?? ""));
    if (!entry) {
        return res.status(404).json({ error: "They're no longer in the queue." });
    }
    if (d.presenter) {
        if (approveWhileBusy(d.presenter) !== "replace") {
            return res.status(409).json({ error: `${d.presenter.name} is on the big screen. Stop them first.` });
        }
        endPresenter(code, "replaced");
    }

    d.queue.splice(d.queue.indexOf(entry), 1);
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.picked = false;
    entry.pickTimer = setTimeout(() => {
        if (d.presenter === entry && !entry.picked) endPresenter(code, "timeout");
    }, DEMO_PENDING_TTL);
    d.presenter = entry;
    if (entry.res) sseWrite(entry.res, { type: "approved" });
    // If their feed is down right now, the grace timer that was dropping them from the queue
    // now ends their turn instead.
    else entry.timer = setTimeout(() => {
        if (d.presenter === entry && !entry.res) endPresenter(code, "lost");
    }, DEMO_GRACE);
    notifyDemo(code);
    logAs(req.actor || code, `Approved ${entry.name} for the big screen`);
    return res.status(200).json({ demo: demoState(code) });
});

app.post("/demoRemove", async function (req, res) {
    const code = authEvent(req, res);
    if (code == null) return;
    const d = demos.get(code);
    const entry = d && d.queue.find(q => q.id === String(req.body.id ?? ""));
    if (entry) {
        dropQueued(code, entry, "removed");
        logAs(req.actor || code, `Removed ${entry.name} from the demo queue`);
    }
    return res.status(200).json({ demo: demoState(code) });
});

// The projector tab. One per event: opening a second one takes over from the first.
app.get("/screenStream", async function (req, res) {
    const opener = redeemTicket(req, res, { allowScreen: true });
    if (opener == null) return;
    const code = getRootCode(opener);

    const d = getDemo(code);
    const previous = d.screen;
    d.screen = res;
    res.paired = !!req.screenOnly;   // opened with a screen key: unpairing closes it
    res.openedBy = opener;           // an organizer leaving the event takes their tab with them
    if (previous) sseEnd(previous, { type: "replaced" });

    openSSE(res);
    sseWrite(res, { type: "hello", iceServers });
    sseWrite(res, { type: "harpa", harpa: harpaState(code) });
    notifyDemo(code);
    // A presenter who was already live has to shake hands again with this new tab.
    if (isLive(d.presenter)) sseWrite(d.presenter.res, { type: "ready", restart: true });

    res.on("close", () => {
        const now = demos.get(code);
        if (!now || now.screen !== res) return;
        now.screen = null;
        dropViewers(code, "screen_gone");
        notifyDemo(code);
    });
});

const DEMO_QUEUE_MAX = 50;

// Joins the queue. Needs a typed name and the code on the big screen.
app.post("/demoJoin", async function (req, res) {
    const body = req.body || {};
    const code = body.code != null ? rootOf(body.code) : "";
    const screenCode = body.screenCode != null ? String(body.screenCode).trim() : "";
    if (!code || !screenCode) {
        return res.status(400).json({ error: "Enter the code on the big screen." });
    }
    const name = cleanName(body.name);
    if (!name) {
        return res.status(400).json({ error: "Type your name so organizers know who you are." });
    }
    const device = typeof body.device === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.device) ? body.device : `${req.ip}|${name.toLowerCase()}`;
    const who = { id: device, name, slack: null };
    const token = getToken(code);
    if (!token || isBanned(token.slack)) {
        return res.status(404).json({ error: "No event found" });
    }
    const d = demos.get(code);
    if (!d || !d.enabled) {
        return res.status(409).json({ error: "Demo time isn't on right now." });
    }
    if (!d.screen) {
        return res.status(409).json({ error: "The big screen isn't connected yet. Ask an organizer." });
    }

    const callerKey = `${code}|${req.ip}`;
    if (recentFailures(callerKey).length >= 5 || recentFailures(code).length >= 30) {
        return res.status(429).json({ error: "Too many wrong codes. Wait a minute and try again." });
    }
    if (!safeEqual(d.screenCode, screenCode)) {
        for (const key of [callerKey, code]) {
            demoFailures.set(key, [...recentFailures(key), Date.now()]);
        }
        return res.status(401).json({ error: "That's not the code on the big screen." });
    }

    // Already waiting or approved (a reload, a second tab): hand back the same place in line.
    const existing = (d.presenter && d.presenter.who === who.id ? d.presenter : null) ||
        d.queue.find(q => q.who === who.id);
    if (existing) {
        return res.status(200).json({ token: existing.token, iceServers });
    }
    if (d.queue.length >= DEMO_QUEUE_MAX) {
        return res.status(409).json({ error: "The queue is full. Try again in a bit." });
    }

    const entry = {
        id: crypto.randomBytes(6).toString("hex"),
        who: who.id,
        name: who.name,
        slack: who.slack,
        token: crypto.randomBytes(32).toString("hex"),
        res: null,
        timer: null,
        pickTimer: null,
        picked: false
    };
    // Dropped if their feed never connects.
    entry.timer = setTimeout(() => dropQueued(code, entry, "lost"), DEMO_PENDING_TTL);
    d.queue.push(entry);
    notifyDemo(code);
    logAs(req.actor || code, `${who.name} joined the demo queue`);
    return res.status(200).json({ token: entry.token, iceServers });
});

// The presenter's feed, open from joining the queue until their turn ends:
// { type: "queued", position }, { type: "approved" }, { type: "ready", restart } (start or
// redo the handshake), { type: "signal", signal } and { type: "ended", reason }.
app.get("/demoStream", async function (req, res) {
    const code = req.query.code != null ? rootOf(req.query.code) : "";
    const p = demoPresenter(code, req.query.token) || demoQueued(code, req.query.token);
    if (!p) {
        return res.status(401).json({ error: "This screenshare has ended" });
    }
    const d = demos.get(code);
    const stale = p.res;
    p.res = res;
    if (stale) sseEnd(stale);
    clearTimeout(p.timer);
    p.timer = null;

    openSSE(res);
    if (d.presenter === p) {
        sseWrite(res, { type: "approved" });
        if (p.picked && d.screen) sseWrite(res, { type: "ready", restart: false });
    }
    notifyDemo(code);

    res.on("close", () => {
        if (p.res !== res) return;
        p.res = null;
        const now = demos.get(code);
        if (!now) return;
        // Wifi blips shouldn't cost anyone their turn or their place in line; for a live
        // presenter the video is peer-to-peer and may well still be playing.
        if (now.presenter === p) {
            p.timer = setTimeout(() => {
                if (now.presenter === p && !p.res) endPresenter(code, "lost");
            }, DEMO_GRACE);
        } else if (now.queue.includes(p)) {
            p.timer = setTimeout(() => {
                if (!p.res) dropQueued(code, p, "lost");
            }, DEMO_GRACE);
        } else {
            return;
        }
        notifyDemo(code);
    });
});

// The approved presenter has picked a window: start the handshake with the projector.
app.post("/demoPicked", async function (req, res) {
    const body = req.body || {};
    const code = body.code != null ? rootOf(body.code) : "";
    const p = demoPresenter(code, body.token);
    if (!p) return res.status(401).json({ error: "This screenshare has ended" });
    const d = demos.get(code);
    p.picked = true;
    clearTimeout(p.pickTimer);
    p.pickTimer = null;
    if (p.res && d.screen) sseWrite(p.res, { type: "ready", restart: false });
    notifyDemo(code);
    return res.status(200).json({ ok: true });
});

app.post("/demoLeave", async function (req, res) {
    const body = req.body || {};
    const code = body.code != null ? rootOf(body.code) : "";
    if (demoPresenter(code, body.token)) {
        endPresenter(code, "left");
    } else {
        const q = demoQueued(code, body.token);
        if (q) dropQueued(code, q, "left");
    }
    return res.status(200).json({ message: "Left" });
});

// Relays one handshake message. A presenter proves themselves with their token; anything
// else must be the projector tab, which holds organizer credentials or a screen key.
app.post("/demoSignal", async function (req, res) {
    const body = req.body || {};
    if (!validSignal(body.signal)) {
        return res.status(400).json({ error: "Invalid signal" });
    }

    if (body.token != null) {
        const code = body.code != null ? rootOf(body.code) : "";
        const p = demoPresenter(code, body.token);
        if (!p || !p.picked) return res.status(401).json({ error: "This screenshare has ended" });
        const d = demos.get(code);
        if (d.screen) sseWrite(d.screen, { type: "signal", from: p.id, signal: body.signal });
        return res.status(200).json({ delivered: !!d.screen });
    }

    const code = authEventScreen(req, res);
    if (code == null) return;
    const d = demos.get(code);
    if (body.viewer != null) {
        const v = validViewer(body.viewer) && d ? d.viewers.get(body.viewer) : null;
        if (v) sseWrite(v, { type: "signal", signal: body.signal });
        return res.status(200).json({ delivered: !!v });
    }
    const p = d && d.presenter;
    // `to` stops an answer meant for the last presenter reaching the next one.
    const delivered = !!(p && p.res && p.id === body.to);
    if (delivered) sseWrite(p.res, { type: "signal", signal: body.signal });
    return res.status(200).json({ delivered });
});

// --- Screen pairing: the big screen on a computer nobody signs in on ---
//
// Venue computers shouldn't hold an organizer's Hack Club sign-in. The console asks for a
// short-lived pairing code; typing it at /screen trades it for the event's screen key, which
// only runs the big screen (/streamTicket for /screenStream, /demoSignal, /demoFrame).
// Unpairing replaces the key, which signs every paired computer out.

const PAIR_TTL = 10 * 60 * 1000;

function newPairCode() {
    let p;
    do p = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    while (pairCodes.has(p));
    return p;
}

setInterval(() => {
    const now = Date.now();
    for (const [p, v] of pairCodes) {
        if (v.expires <= now) pairCodes.delete(p);
    }
}, 60 * 1000).unref();

app.post("/screenPairCode", async function (req, res) {
    const code = authEvent(req, res);
    if (code == null) return;
    // One live pairing code per event: asking again replaces it.
    for (const [p, v] of pairCodes) {
        if (v.code === code) pairCodes.delete(p);
    }
    tokens[code].screenKey ??= crypto.randomBytes(32).toString("hex");
    const pairCode = newPairCode();
    const expires = Date.now() + PAIR_TTL;
    pairCodes.set(pairCode, { code, expires });
    notifyDemo(code);
    logAs(req.actor || code, "Created a screen pairing code");
    return res.status(200).json({ pairCode, expires });
});

app.post("/screenPair", async function (req, res) {
    const pairCode = req.body && req.body.pairCode != null ? String(req.body.pairCode).replace(/\D/g, "") : "";
    const callerKey = `pair|${req.ip}`;
    if (recentFailures(callerKey).length >= 5 || recentFailures("pair").length >= 60) {
        return res.status(429).json({ error: "Too many wrong codes. Wait a minute and try again." });
    }
    const entry = pairCodes.get(pairCode);
    const token = entry && entry.expires > Date.now() ? getToken(entry.code) : undefined;
    if (!token || !token.screenKey || isBanned(token.slack)) {
        for (const key of [callerKey, "pair"]) {
            demoFailures.set(key, [...recentFailures(key), Date.now()]);
        }
        return res.status(401).json({ error: "That code didn't work. Codes last 10 minutes; get a new one from the organizer console." });
    }
    pairCodes.delete(pairCode);
    logAs(entry.code, "Paired a big screen");
    return res.status(200).json({ code: entry.code, screenKey: token.screenKey });
});

app.post("/screenUnpair", async function (req, res) {
    const code = authEvent(req, res);
    if (code == null) return;
    delete tokens[code].screenKey;
    for (const [p, v] of pairCodes) {
        if (v.code === code) pairCodes.delete(p);
    }
    const d = demos.get(code);
    if (d && d.screen && d.screen.paired) sseEnd(d.screen, { type: "revoked", reason: "unpaired" });
    notifyDemo(code);
    logAs(req.actor || code, "Unpaired all big screens");
    return res.status(200).json({ message: "Paired screens signed out" });
});

// --- Admin ---

// The read-only endpoints below take credentials in a POST body. GET (credentials in the
// query string) is kept only so the frontend currently deployed keeps working; remove it
// once the POST-based frontend is live.
async function allEvents(req, res) {
    const code = authAdmin(req, res);
    if (code == null) return;

    let returnList = tokens;
    
    for (let i = 0; i < Object.entries(tokens).length; i++) {
        let code = Object.entries(tokens)[i][0];
        returnList[code].packet = packets[code];
    }

    let items = JSON.stringify(returnList);
    logAs(code, "Requested all events through admin");
    return res.status(200).json({ list: items });
}
app.route("/allEvents").get(allEvents).post(allEvents);


app.post("/setEvents", async function (req, res) {
    const code = authAdmin(req, res);
    if (code == null) return;
    const { items } = req.body;
    if (!items) {
        return res.status(400).json({ error: "Missing list" });
    }

    let parsed;
    try {
        parsed = JSON.parse(items);
    } catch (e) {
        return res.status(400).json({ error: "Invalid JSON format for items" });
    }

    // Validate before touching live state.
    const problem = validateEvents(parsed);
    if (problem) {
        return res.status(400).json({ error: problem });
    }

    logAs(code, "Replaced all events through admin");

    // Extract packets before assigning the event data to tokens.
    let newPackets = {};
    for (const [eventCode, event] of Object.entries(parsed)) {
        newPackets[eventCode] = event.packet ?? null;
        delete event.packet;
    }

    for (let clientResList of Object.values(sessions)) {
        for (let clientRes of clientResList) {
            sseEnd(clientRes, { error: "Events database replaced by administrator" });
        }
    }
    for (const c of [...orgStreams.keys()]) {
        closeOrgStreams(c, { type: "reset", message: "Events database replaced by administrator" });
    }
    for (const c of [...demos.keys()]) {
        closeDemo(c, { type: "reset", message: "Events database replaced by administrator" });
    }

    tokens = parsed;
    packets = newPackets;

    for (const c of [...harpaOn]) {
        if (!getToken(c)) harpaOn.delete(c);
    }

    normalizeMerges();
    mergeInvites.clear();
    pairCodes.clear();
    streamTickets.clear();
    sessions = {};

    for (const jumbotronCode of Object.keys(tokens)) {
        sessions[jumbotronCode] = [];
    }

    return res.status(200).json({
        message: "Updated events, closed all active sessions, and restored packets successfully."
    });
});


app.post("/banEvent", async function (req, res) {
    const code = authAdmin(req, res);
    if (code == null) return;
    let { banSlack, banList } = req.body;
    if (!banSlack && !banList) {
        return res.status(400).json({ error: "Missing parameters" });
    }

    const banUserBySlack = (targetSlack) => {
        for (let [jumbotronCode, tokenObj] of Object.entries(tokens)) {
            if (tokenObj.slack === targetSlack) {
                purgeEvent(jumbotronCode, { error: "User banned by administrator" });
            }
        }
        // Invites waiting for someone who never signed in.
        for (const inv of invitesTo(targetSlack)) dropInvite(inv, "invite_unavailable", null);
        if (!banned.includes(targetSlack)) {
            banned.push(targetSlack);
        }
        kickAttendee(targetSlack);
    };

    if (banSlack) {
        let targetSlack = String(banSlack).trim();
        logAs(code, `Banned and purged Slack ID ${targetSlack}`);
        banUserBySlack(targetSlack);
        return res.status(200).json({ message: `Slack ID ${targetSlack} has been banned and terminated.` });
    }
    if (!Array.isArray(banList)) {
        return res.status(400).json({ error: "banList must be an array" });
    }
    banned = [];
    for (let targetSlack of banList) {
        banUserBySlack(targetSlack);
    }
    logAs(code, `Set ban list and purged active events`);
    return res.status(200).json({ message: `Ban list updated and active sessions terminated.` });
});

app.post("/unbanEvent", async function (req, res) {
    const code = authAdmin(req, res);
    if (code == null) return;
    let { unbanSlack } = req.body;
    if (!unbanSlack) {
        return res.status(400).json({ error: "Missing Slack ID" });
    }

    banned = banned.filter(x => x != unbanSlack);
    logAs(code, `Unbanned ${unbanSlack}`);
    return res.status(200).json({ message: "Unbanned user" });
});

async function getBans(req, res) {
    const code = authAdmin(req, res);
    if (code == null) return;

    return res.status(200).json({ list: JSON.stringify(banned) });
}
app.route("/getBans").get(getBans).post(getBans);

async function getAdmins(req, res) {
    const code = authOrganizer(req, res);
    if (code == null) return;

    return res.status(200).json({admins: admins});
}
app.route("/getAdmins").get(getAdmins).post(getAdmins);

// --- Harpa (lo-fi music on the big screen) ---
//
// The big screen embeds https://harpa.hackclub.com when an organizer turns it on. Harpa keeps
// its own settings (playlist, logo, MP3s) inside the embed on the projector; this server only
// carries the on/off switch, as { type: "harpa", harpa } on /orgStream and /screenStream.

function harpaState(code) {
    return { enabled: harpaOn.has(code) };
}

app.post("/harpaSet", async function (req, res) {
    const code = authEvent(req, res);
    if (code == null) return;
    const enabled = req.body && req.body.enabled;
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "Send enabled as true or false" });
    if (harpaOn.has(code) !== enabled) {
        if (enabled) harpaOn.add(code);
        else harpaOn.delete(code);
        const payload = { type: "harpa", harpa: harpaState(code) };
        for (const c of groupCodes(code)) {
            for (const s of orgStreams.get(c) || []) sseWrite(s, payload);
        }
        const d = demos.get(code);
        if (d && d.screen) sseWrite(d.screen, payload);
        logAs(req.actor || code, `Turned harpa ${enabled ? "on" : "off"}`);
    }
    return res.status(200).json({ harpa: harpaState(code) });
});

// Keep this after every route: anything that reaches it is unknown.
app.use(function (req, res) {
    res.status(404).json({ error: "Not found" });
});

// JSON errors only: Express's default handler answers with HTML and, outside
// NODE_ENV=production, the stack trace.
app.use(function (err, req, res, next) {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(`${req.method} ${req.path} failed:`, err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status >= 500 ? "Internal server error" : (err.expose && err.message) || "Bad request" });
});

const port = process.env.PORT || 3000;

app.listen(port, function() {
    console.log(`Jumbotron running on port ${port}`);
});
