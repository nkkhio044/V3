const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { createBot } = require('./bot');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const BOTS_DB = path.join(DATA_DIR, 'bots.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(BOTS_DB)) fs.writeFileSync(BOTS_DB, '[]');

// creds.json upload — stored straight into that bot's own session folder
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB is plenty for a creds.json
});

// runtime registry: botId -> { instance, meta, statusMsg }
const runtime = new Map();

function readBotsDb() {
    return JSON.parse(fs.readFileSync(BOTS_DB, 'utf-8'));
}
function writeBotsDb(list) {
    fs.writeFileSync(BOTS_DB, JSON.stringify(list, null, 2));
}

function publicView(meta, instance) {
    return {
        id: meta.id,
        botName: meta.botName,
        ownerName: meta.ownerName,
        ownerNumber: meta.ownerNumber,
        bio: meta.bio,
        prefix: meta.prefix,
        createdAt: meta.createdAt,
        status: instance ? instance.getStatus() : 'stopped',
        statusMessage: runtime.get(meta.id)?.statusMsg || '',
    };
}

function attachInstance(meta) {
    const instance = createBot(
        {
            botName: meta.botName,
            ownerName: meta.ownerName,
            ownerNumber: meta.ownerNumber,
            bio: meta.bio,
            prefix: meta.prefix,
            apiKey: meta.apiKey,
            sessionDir: path.join(SESSIONS_DIR, meta.id),
        },
        {
            onStatus: (s) => {
                const r = runtime.get(meta.id);
                if (r) r.statusMsg = '';
            },
            onConnected: () => {
                const r = runtime.get(meta.id);
                if (r) r.statusMsg = `${meta.botName} WhatsApp se connected hai.`;
            },
            onError: (msg) => {
                const r = runtime.get(meta.id);
                if (r) r.statusMsg = msg;
            },
        }
    );
    runtime.set(meta.id, { instance, statusMsg: '' });
    return instance;
}

// Load existing bots from disk on boot (does NOT auto-connect any of them —
// user has to press Start, so nothing runs without them asking).
function loadExistingBots() {
    const list = readBotsDb();
    for (const meta of list) {
        attachInstance(meta);
    }
}
loadExistingBots();

// ============================================
// API — list all bots
// ============================================
app.get('/api/bots', (req, res) => {
    const list = readBotsDb();
    res.json(list.map(meta => publicView(meta, runtime.get(meta.id)?.instance)));
});

// ============================================
// API — create a new bot (multipart: credsFile + fields)
// ============================================
app.post('/api/bots', upload.single('credsFile'), (req, res) => {
    const { botName, ownerName, ownerNumber, bio, prefix, apiKey } = req.body;

    if (!ownerNumber || !apiKey || !req.file) {
        return res.status(400).json({ error: 'Owner number, API key, aur creds.json — teeno zaroori hain.' });
    }

    let parsedCreds;
    try {
        parsedCreds = JSON.parse(req.file.buffer.toString('utf-8'));
    } catch (e) {
        return res.status(400).json({ error: 'Ye valid creds.json file nahi lag rahi (JSON parse fail hua).' });
    }

    const id = crypto.randomUUID();
    const sessionDir = path.join(SESSIONS_DIR, id);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'creds.json'), JSON.stringify(parsedCreds, null, 2));

    const meta = {
        id,
        botName: botName || 'Dox',
        ownerName: ownerName || 'Owner',
        ownerNumber: ownerNumber.replace(/[^0-9]/g, ''),
        bio: bio || '',
        prefix: prefix || '!',
        apiKey, // stored server-side only, never sent back to the browser
        createdAt: new Date().toISOString(),
    };

    const list = readBotsDb();
    list.push(meta);
    writeBotsDb(list);

    const instance = attachInstance(meta);

    res.json({ ok: true, bot: publicView(meta, instance) });
});

// ============================================
// API — start / stop / delete a bot
// ============================================
app.post('/api/bots/:id/start', async (req, res) => {
    const r = runtime.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Bot nahi mila.' });
    try {
        await r.instance.start();
        res.json({ ok: true });
    } catch (err) {
        r.statusMsg = err.message;
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/bots/:id/stop', async (req, res) => {
    const r = runtime.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Bot nahi mila.' });
    await r.instance.stop();
    res.json({ ok: true });
});

app.delete('/api/bots/:id', async (req, res) => {
    const r = runtime.get(req.params.id);
    if (r) {
        await r.instance.stop();
        runtime.delete(req.params.id);
    }
    const sessionDir = path.join(SESSIONS_DIR, req.params.id);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const list = readBotsDb().filter(b => b.id !== req.params.id);
    writeBotsDb(list);

    res.json({ ok: true });
});

app.get('/api/bots/:id/status', (req, res) => {
    const list = readBotsDb();
    const meta = list.find(b => b.id === req.params.id);
    if (!meta) return res.status(404).json({ error: 'Bot nahi mila.' });
    const r = runtime.get(req.params.id);
    res.json(publicView(meta, r?.instance));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Multi-user bot dashboard chal raha hai: http://localhost:${PORT}`);
});
