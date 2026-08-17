import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import crypto from "crypto";
dotenv.config();

const masterKey = process.env.MASTER;

const app = express();
app.use(express.json());
app.use(cors({
    origin: [
        "https://cuddly-space-waffle-jjv54wrjpjxvfqj55-5173.app.github.dev",
        "https://jumbotron.hackclub.com"
    ],
    methods: [
        "POST", "GET"
    ],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}))

let validCitiesCache = [];
let pocEmailsCache = [];

let events = [];
let sessions = [];

let clientID = "e86d4d7eec9c546e6c4700388d4fea7f";

async function cacheCities() {
    try {
        //const rawData = await fetch("https://raw.githubusercontent.com/lynn89-eefje/jumbotron-events/refs/heads/main/data.json");
        //const data = await rawData.json();
        let data = process.env.REF.split("*");
        validCitiesCache = data.map(event => event.split(";")[0]);
        pocEmailsCache = data.map(event => event.split(";")[1].split(","))
        console.log("Cached events");
    } catch(err) {
        console.error("Failed to cache cities: ", err);
    }
}

function checkCity(cityName) {
    return validCitiesCache.includes(cityName);
}

// Synchronous now, as it just looks up and pushes to a local array
function ensureEvent(eventName) {
    if (!checkCity(eventName)) {
        return false;
    }
    
    // Find event in our local list
    let event = events.find(e => e.name === eventName);

    // If it doesn't exist, create it and push it to the list
    if (!event) {
        event = { 
            name: eventName, 
            acceptedEmails: pocEmailsCache[validCitiesCache.indexOf(eventName)],
            liveshareData: {} 
        };
        events.push(event);
    }

    return [
        event.name, event.acceptedEmails, event.liveshareData
    ];
}

function timeDiff(timestamp) {
    if (timestamp == null) {
        return true;
    }
    let clock = new Date();
    let curr = clock.getTime();
    let diff = curr - timestamp;
    diff = diff/1000/60;
    if (diff > 30) {
        return true
    }
    return false;
}

function cleanUp() {
    //let events = events.fitler(x => x.liveshareData.active != false);
    for (let i in events) {
        if (streams[events[i].cityName] == null || streams[events[i].cityName] == []) {
            if (events[i].liveshareData.active == false || timeDiff(events[i].liveshareData.timestamp) == true) {
                console.log(`Removing ${events[i].cityName} to clear memory`)
                events = events.filter(e => e.cityName != events[i].cityName);
            }
        }
    }
}


setInterval(cleanUp, 1000*60*5);


async function sendDataToSlack() {
    const slackToken = process.env.BOT_TOKEN;
    const channelId = process.env.CHANNEL_ID;

    if (!slackToken || !channelId) {
        console.error("Missing Slack environment variables.");
        return;
    }

    // Isolate only emails per city; completely exclude active sessions and liveshare states
    const emailOnlyBackup = events.map(event => ({
        name: event.name,
        acceptedEmails: [...event.acceptedEmails]
    }));

    // Package directly into the requested structured JSON format
    const adminConsolePayload = {
        authKey: masterKey || 'your_master_key',
        eventsNew: emailOnlyBackup,
        sessionsNew: [] // Explicitly reset sessions to keep it clean
    };

    const payloadString = JSON.stringify(adminConsolePayload, null, 2);

    try {
        // Post directly to the chat channel as a clean markdown block for your admin console
        const response = await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": `Bearer ${slackToken}`
            },
            body: JSON.stringify({
                channel: channelId,
                text: `🚨 *Jumbotron Email Configuration Snapshot* 🚨\nTotal Tracked Cities: *${emailOnlyBackup.length}* | _Active active login sessions excluded._\n\n*Copy and paste this JSON data block directly into your admin console or use with /mutate:* \n\`\`\`json\n${payloadString}\n\`\`\``
            })
        });

        const result = await response.json();
        if (!result.ok) {
            console.error("Slack chat.postMessage Error:", result.error);
        } else {
            console.log("JSON admin console payload posted to Slack channel!");
        }
    } catch (err) {
        console.error("Failed to post JSON backup to Slack:", err);
    }
}

// --- Express Routes ---
app.get(`/data`, async function(req, res) {
    const { eventName } = req.query;
    if (!eventName) {
        return res.status(400).json({ error: "Missing eventName query parameter" });
    }

    try {
        const response = ensureEvent(eventName);
        if (response === false) {
            return res.status(404).json({ error: "Invalid eventName value; did not find event" });
        }

        const [name, acceptedEmails, liveshareData] = response;
        res.status(200).json({ data: liveshareData });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.get("/acceptedEmails", async (req, res) => {
    let {authKey, cityName} = req.query;
    if (!authKey || authKey !== masterKey || !cityName) {
        return res.status(400).json({ error: "Missing parameter or invalid auth query parameter" });
    }
    
    const response = ensureEvent(cityName); // No longer needs await
    if (!response) {
        return res.status(400).json({error: "Invalid cityName"});
    }
    const [ acceptName, acceptedEmails, rawData ] = response;
    res.status(200).json({data: acceptedEmails});
});

app.post("/addEmail", async (req, res) => {
    let {authKey, cityName, emailAddress} = req.body;
    if (!authKey || !cityName || !emailAddress) {
        return res.status(400).json({error: "Missing parameter(s)"});
    }
    if (authKey !== masterKey) {
        return res.status(401).json({error: "Invalid auth query parameter"});
    }
    let details = ensureEvent(cityName);
    if (!details) {
        return res.status(400).json({error: "Invalid cityName"});
    }
    for (let i = 0; i < events.length; i++) {
        if (events[i].name === cityName) {
            if (events[i].acceptedEmails.indexOf(emailAddress) === -1) {
                events[i].acceptedEmails.push(emailAddress);
                return res.status(200).json({message: "Added email"});
            }
            else {
                return res.status(400).json({error: "Email is already on the list"});
            }
        }
    }
    
})

app.post("/removeEmail", async (req, res) => {
    let {authKey, cityName, emailAddress} = req.body;
    if (!authKey || !cityName || !emailAddress) {
        return res.status(400).json({error: "Missing parameter(s)"});
    }
    if (authKey !== masterKey) {
        return res.status(401).json({error: "Invalid auth query parameter"});
    }
    let details = ensureEvent(cityName);
    if (!details) {
        return res.status(400).json({error: "Invalid cityName"});
    }
    for (let i = 0; i < events.length; i++) {
        if (events[i].name === cityName) {
            if (events[i].acceptedEmails.indexOf(emailAddress) !== -1) {
                events[i].acceptedEmails = events[i].acceptedEmails.filter(e => e !== emailAddress);
                return res.status(200).json({message: "Removed email"});
            }
            else {
                return res.status(400).json({error: "Email is not on the list"});
            }
        }
    }
})
app.use(["/mutate", "/terminateLiveshare"], express.text({ type: ["text/plain", "*/*"] }), (req, res, next) => {
    if (typeof req.body === "string" && req.body.trim().startsWith("{")) {
        try {
            req.body = JSON.parse(req.body);
        } catch (err) {
            console.error("Failed to parse plain-text JSON beacon:", err);
        }
    }
    // Ensure req.body is at least an object if parsing didn't occur
    req.body = req.body || {};
    next();
});
app.post("/wipeSessions", async (req, res) => {
    let {authKey} = req.body;
    if (!authKey || authKey !== masterKey) {
        return res.status(401).json({error: "Not allowed"});
    }
    sessions = [];
    sendDataToSlack();
    return res.status(200).json({message: "All sessions have been wiped"});
});
app.post("/mutate", async (req, res) => {
    let {auth, cityName, data} = req.body;
    if (!auth || !cityName || !data) {
        return res.status(400).json({error: "Missing parameter(s)"});
    }
    let response = ensureEvent(cityName);
    if (!response) {
        return res.status(400).json({error: "Invalid cityName"});
    }
    if (auth !== masterKey) {
        if (!auth.emailAddress || !auth.key) {
            return res.status(400).json({error: "Invalid auth parameter"});
        }
        console.log(`/mutate by ${auth.emailAddress}`);
        const [name, acceptedEmails] = response;
        if (acceptedEmails.indexOf(auth.emailAddress) === -1) {
            return res.status(400).json({error: "Invalid email"});
        }
        let validSet = sessions.find(e => e.key === auth.key && e.cityName === cityName);
        if (!validSet) {
            return res.status(401).json({error: "Invalid authentication"});
        }
        if (validSet.emailAddress !== auth.emailAddress) {
            return res.status(401).json({error: "Invalid authentication"});
        }
    }
    for (let i = 0; i < events.length; i++) {
        if (events[i].name === cityName) {
            events[i].liveshareData = data;
            broadcastToCity(cityName, data);
            return res.status(200).json({message: "Changed liveshare data"});
        }
    }
})

app.post("/terminateLiveshare", async (req, res) => {
    let {emailAddress, key, cityName} = req.body;
    if (!emailAddress || !key || !cityName) {
        return res.status(400).json({error: "Missing parameter(s)"});
    }
    if (ensureEvent(cityName) === false) {
        return res.status(400).json({error: "Invalid cityName"});
    }
    let valid = events.find(e => e.acceptedEmails.indexOf(emailAddress) != -1 && e.name === cityName);
    if (!valid) {
        return res.status(401).json({error: "Email address is not added to this event"});
    }
    let valid2 = sessions.find(e => e.emailAddress === emailAddress && e.key === key);
    if (!valid2) {
        return res.status(401).json({error: "Invalid credential"});
    }
    let index = events.findIndex(e => e.name == cityName);
    if (index === -1) {
        return res.status(500).json({error: "Index mismatch"});
    }
    events[index].liveshareData = {active: false};
    broadcastToCity(cityName, {active: false});
    return res.status(200).json({message: "Success"});
})

app.post("/masterOverride", async (req, res) => {
    let {authKey, eventsNew, sessionsNew} = req.body;
    if (!authKey || !eventsNew || !sessionsNew) {
        return res.status(400).json({error: "Missing parameter(s)"});
    }
    if (authKey !== masterKey) {
        return res.status(401).json({error: "Invalid auth query parameter"});
    }

    cacheCities();

    events = eventsNew;
    sessions = sessionsNew;

    sendDataToSlack();
    return res.status(200).json({ message: "Override successful and state backup triggered." });
});

app.post("/forceCache", async (req, res) => {
    let {authKey} = req.body;
    if (authKey === masterKey) {
        cacheCities();
        return res.status(200).json({message: "Cached"});
    }
    return res.status(401).json({error: "Missing or invalid parameter"});
})

app.post("/genBackup", async (req, res) => {
    let {authKey} = req.body;
    if (authKey !== masterKey) {
        return res.status(400).json({error: "Invalid auth"});
    }
    sendDataToSlack();
    return res.status(200).json({message: "Sent through Slack"});
})

app.post("/createSession", async (req, res) => {
    let {code, cityName} = req.body;
    if (!code || !cityName) {
        return res.status(400).json({error: "Missing parameter(s)"});
    }
    let cityExists = ensureEvent(cityName);
    if (!cityExists) {
        return res.status(400).json({error: "Invalid cityName"});
    }
    const response = await fetch("https://auth.hackclub.com/oauth/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            client_id: clientID,
            client_secret: process.env.CLIENT_SECRET,
            redirect_uri: process.env.REDIRECT,
            code: code,
            grant_type: "authorization_code"
        })
    });

    const data = await response.json();
    if (!response.ok) {
        return res.status(400).json({ error: "OAuth exchange failed", details: data });
    }

    // https://auth.hackclub.com/api/v1/me

    const getInfo = await fetch("https://auth.hackclub.com/api/v1/me", {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${data.access_token}`
        },

    })
    const data2 = await getInfo.json();
    //console.log("New session validated for ", data2.identity.primary_email);
    if (data2.identity.verification_status === "ineligible") {
        return res.status(401).json({error: "User must be YSWS eligible"});
    }
    let [eventName, acceptedEmails, liveshareData] = cityExists;
    if (acceptedEmails.indexOf(data2.identity.primary_email) == -1) {
        return res.status(401).json({error: "Email is not accepted for this event: must be added using /addEmail"});
    }

    const generateKey = () => {return crypto.randomBytes(32).toString("hex")}
    const key = generateKey();
    sessions = sessions.filter(e => e.emailAddress !== data2.identity.primary_email);
    sessions.push({
        emailAddress: data2.identity.primary_email,
        cityName: cityName,
        key: key
    })
    console.log(`Created new login session for ${data2.identity.primary_email}, ${cityName}`)
    //console.log("New session validated for ", data2.identity.primary_email);
    return res.status(200).json({emailAddress: data2.identity.primary_email, key: key});
})

let streams = {};
app.get("/stream", (req, res) => {
    let {cityName} = req.query;
    if (!cityName) {
        return res.status(400).json({error: "Missing cityName"});
    }
    if (ensureEvent(cityName) === false) {
        return res.status(400).json({error: "Invalid cityName"});
    }


    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    })

    res.write(`data: ${JSON.stringify({message: "Connected to stream"})}\n\n`);

    if (streams[cityName] == null ) {
        streams[cityName] = [];
    }
    streams[cityName].push(res)

    req.on("close", () => {
        streams[cityName] = streams[cityName].filter(e => e !== res);
        if (streams[cityName] && streams[cityName].length === 0) {
            delete streams[cityName];
        }
    })
})

function broadcastToCity(cityName, data) {
    if (streams[cityName]) {
        let message = `data: ${JSON.stringify(data)}\n\n`; // \n\n is required
        streams[cityName].forEach(e => e.write(message));
    } 
}


// --- Server Startup ---
await cacheCities();
await sendDataToSlack();
const port = process.env.PORT || 3000; 

setInterval(async () => {
    await sendDataToSlack();
    //await cacheCities();
}, 30*1000*60)

app.listen(port, function() {
    console.log(`Jumbotron running on port ${port}`);
});
app.set('trust proxy', 'loopback');
