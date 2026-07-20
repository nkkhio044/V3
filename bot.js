const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ============================================
// createBot(config, callbacks) -> { start, stop, getStatus }
//
// config: { botName, ownerName, ownerNumber, bio, prefix, apiKey, sessionDir }
// callbacks: { onConnected(), onStatus(status), onError(message) }
//
// Har user ka apna alag instance banta hai is factory se — isliye 2, 20, ya
// 200 users apna-apna bot ek hi server par chala sakte hain, bina ek-doosre
// ka data mix hue.
// ============================================
function createBot(config, callbacks = {}) {
    const CONFIG = {
        botName: config.botName || 'Dox',
        ownerName: config.ownerName || 'Owner',
        ownerNumber: (config.ownerNumber || '').replace(/[^0-9]/g, ''),
        bio: config.bio || '',
        prefix: config.prefix || '!',
        apiKey: config.apiKey || '',
        sessionDir: config.sessionDir,
    };

    const startTime = Date.now();
    const userHistory = new Map();
    const adminList = new Set([CONFIG.ownerNumber]);

    let sock = null;
    let status = 'stopped'; // stopped | connecting | connected | reconnecting | logged_out | error
    let stoppedByUser = false;

    function setStatus(s) {
        status = s;
        if (callbacks.onStatus) callbacks.onStatus(s);
    }

    function getUptime() {
        const ms = Date.now() - startTime;
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        const h = Math.floor(m / 60);
        const d = Math.floor(h / 24);
        if (d > 0) return `${d} din, ${h % 24} ghante`;
        if (h > 0) return `${h} ghante, ${m % 60} minute`;
        if (m > 0) return `${m} minute, ${s % 60} second`;
        return `${s} second`;
    }

    function isAdmin(sender) {
        const num = sender.replace('@s.whatsapp.net', '').replace('@g.us', '');
        return adminList.has(num) || sender === CONFIG.ownerNumber + '@s.whatsapp.net';
    }

    function getUserHistory(userId) {
        if (!userHistory.has(userId)) userHistory.set(userId, []);
        return userHistory.get(userId);
    }

    // ============================================
    // AI REPLY — Text
    // ============================================
    async function getAIReply(userId, userMessage) {
        try {
            const history = getUserHistory(userId);
            history.push({ role: 'user', content: userMessage });
            if (history.length > 20) history.splice(0, history.length - 20);

            const bioLine = CONFIG.bio ? `\nBio/context: ${CONFIG.bio}` : '';
            const systemPrompt = `Tu ${CONFIG.botName} hai — ${CONFIG.ownerName} ka WhatsApp AI assistant. Tu bilkul ${CONFIG.ownerName} ki tarah baat karta hai.${bioLine}

Personality:
- Casual aur friendly, "bhai" aur "yaar" aksar use karta hai
- Hindi aur English mix (Hinglish)
- Technical cheezein simple karke samjhata hai
- Helpful, seedha answer, bakwaas nahi
- Thoda funny bhi kabhi kabhi
- Short aur clear replies

Rules:
- Hamesha ${CONFIG.ownerName} ki tarah baat kar
- "Main AI hoon" mat bol kabhi
- Harmful cheez kabhi mat bata
- Conversation natural rakho`;

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // 👇👇👇 IS BOT KI OWN API KEY YAHAN LAGTI HAI 👇👇👇
                    'x-api-key': CONFIG.apiKey || '',
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 500,
                    system: systemPrompt,
                    messages: history
                })
            });

            const data = await response.json();
            if (data.error) throw new Error(data.error.message);

            const reply = data.content[0].text;
            history.push({ role: 'assistant', content: reply });
            return reply;

        } catch (err) {
            console.error(`[${CONFIG.botName}] AI Text Error:`, err.message);
            return 'Bhai abhi thoda busy hoon, baad me baat karte hain 😅';
        }
    }

    // ============================================
    // AI REPLY — Image Vision
    // ============================================
    async function getImageAIReply(userId, imageBase64, caption, mimeType) {
        try {
            const history = getUserHistory(userId);
            const userText = caption || 'Is image me kya hai? Detail me bata.';

            const systemPrompt = `Tu ${CONFIG.botName} hai — ${CONFIG.ownerName} ka WhatsApp AI assistant. Image dekh ke ${CONFIG.ownerName} ki tarah casual Hinglish me bata ki usme kya hai aur user kya jaanna chahta hai.`;

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // 👇👇👇 IS BOT KI OWN API KEY YAHAN LAGTI HAI 👇👇👇
                    'x-api-key': CONFIG.apiKey || '',
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 500,
                    system: systemPrompt,
                    messages: [{
                        role: 'user',
                        content: [
                            {
                                type: 'image',
                                source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 }
                            },
                            { type: 'text', text: userText }
                        ]
                    }]
                })
            });

            const data = await response.json();
            if (data.error) throw new Error(data.error.message);

            const reply = data.content[0].text;
            history.push({ role: 'user', content: `[Image bheja]: ${userText}` });
            history.push({ role: 'assistant', content: reply });
            return reply;

        } catch (err) {
            console.error(`[${CONFIG.botName}] AI Image Error:`, err.message);
            return 'Bhai image dekh nahi paa raha abhi, thodi der baad try karo 😅';
        }
    }

    // ============================================
    // YOUTUBE AUDIO SEARCH (Free)
    // ============================================
    async function searchAndSendAudio(sockRef, msg, query) {
        try {
            await sendMessage(sockRef, msg, `🔍 "${query}" dhundh raha hoon...`);

            const searchRes = await fetch(
                `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`
            );
            const html = await searchRes.text();
            const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);

            if (!match) {
                return await sendMessage(sockRef, msg, '❌ Song nahi mila bhai, doosra naam try karo');
            }

            const videoId = match[1];
            const audioUrl = `https://www.yt-download.org/api/button/mp3/${videoId}`;
            const dlRes = await fetch(audioUrl);
            const dlHtml = await dlRes.text();
            const mp3Match = dlHtml.match(/href="(https:\/\/[^"]*\.mp3[^"]*)"/);

            if (!mp3Match) {
                return await sendMessage(sockRef, msg, `❌ Download link nahi mila bhai 😅\n\nYouTube pe directly suno:\nhttps://youtu.be/${videoId}`);
            }

            await sendMessage(sockRef, msg, '⬇️ Download ho raha hai...');
            await sockRef.sendMessage(msg.key.remoteJid, {
                audio: { url: mp3Match[1] }, mimetype: 'audio/mpeg', ptt: false
            }, { quoted: msg });

        } catch (err) {
            console.error('Audio error:', err.message);
            await sendMessage(sockRef, msg, '❌ Song download nahi hua bhai, internet slow hai ya song available nahi 😅');
        }
    }

    // ============================================
    // COMMANDS
    // ============================================
    const commands = {
        help: {
            handler: async (sockRef, msg, args, sender) => {
                const isOwner = isAdmin(sender);
                let text = `*🤖 ${CONFIG.botName} Commands*\n\n`;
                text += `*👤 General:*\n`;
                text += `${CONFIG.prefix}help - Ye list\n`;
                text += `${CONFIG.prefix}ping - Bot check\n`;
                text += `${CONFIG.prefix}about - Bot info\n`;
                text += `${CONFIG.prefix}ai [sawaal] - AI se poochho\n`;
                text += `${CONFIG.prefix}song [naam] - Song mangwao\n`;
                text += `${CONFIG.prefix}clear - History clear\n`;
                if (isOwner) {
                    text += `\n*👑 Admin Only:*\n`;
                    text += `${CONFIG.prefix}sticker - Image ko sticker banao\n`;
                    text += `${CONFIG.prefix}addadmin [number] - Admin add karo\n`;
                    text += `${CONFIG.prefix}deladmin [number] - Admin hatao\n`;
                    text += `${CONFIG.prefix}broadcast [msg] - Sab ko message bhejo\n`;
                }
                text += `\n_Ya koi bhi message karo — AI reply karega! 😄_`;
                await sendMessage(sockRef, msg, text);
            }
        },
        ping: {
            handler: async (sockRef, msg) => {
                const start = Date.now();
                await sendMessage(sockRef, msg, `🏓 Pong bhai!\n⚡ Speed: ${Date.now() - start}ms\n⏱ Uptime: ${getUptime()}`);
            }
        },
        about: {
            handler: async (sockRef, msg) => {
                const bioLine = CONFIG.bio ? `\n📝 *Bio:* ${CONFIG.bio}\n` : '';
                const text =
`╔══════════════════╗
║   🤖 *${CONFIG.botName} BOT*   ║
╚══════════════════╝

👑 *Owner:* ${CONFIG.ownerName}
🤖 *Bot Name:* ${CONFIG.botName}${bioLine}
📱 *Platform:* WhatsApp
🧠 *AI:* Claude (Anthropic)

📊 *Stats:*
• Uptime: ${getUptime()}
• Active Chats: ${userHistory.size}
• Admins: ${adminList.size}

_Powered by Dox Platform_ 🚀`;
                await sendMessage(sockRef, msg, text);
            }
        },
        ai: {
            handler: async (sockRef, msg, args, sender) => {
                if (!args.length) return await sendMessage(sockRef, msg, 'Bhai kuch toh poochh! 😄\nExample: !ai Python kya hai?');
                await sendMessage(sockRef, msg, '🤔 Soch raha hoon...');
                const reply = await getAIReply(sender, args.join(' '));
                await sendMessage(sockRef, msg, reply);
            }
        },
        song: {
            handler: async (sockRef, msg, args) => {
                if (!args.length) return await sendMessage(sockRef, msg, '❌ Song ka naam daalo!\nExample: !song Kesariya');
                await searchAndSendAudio(sockRef, msg, args.join(' '));
            }
        },
        clear: {
            handler: async (sockRef, msg, args, sender) => {
                userHistory.delete(sender);
                await sendMessage(sockRef, msg, '✅ History clear ho gayi bhai! Fresh start 😄');
            }
        },
        sticker: {
            adminOnly: true,
            handler: async (sockRef, msg, args, sender) => {
                if (!isAdmin(sender)) return await sendMessage(sockRef, msg, '❌ Ye command sirf admin ke liye hai!');
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                const hasImage = msg.message?.imageMessage || quoted?.imageMessage;
                if (!hasImage) return await sendMessage(sockRef, msg, '❌ Image ke saath reply me !sticker likho!');
                try {
                    await sendMessage(sockRef, msg, '⏳ Sticker ban raha hai...');
                    const imgMsg = msg.message?.imageMessage || quoted?.imageMessage;
                    const buffer = await downloadMediaMessage({ message: { imageMessage: imgMsg }, key: msg.key }, 'buffer', {});
                    await sockRef.sendMessage(msg.key.remoteJid, { sticker: buffer }, { quoted: msg });
                } catch (err) {
                    await sendMessage(sockRef, msg, '❌ Sticker nahi bana bhai, image dobara bhejo');
                }
            }
        },
        addadmin: {
            adminOnly: true,
            handler: async (sockRef, msg, args, sender) => {
                if (sender !== CONFIG.ownerNumber + '@s.whatsapp.net') return await sendMessage(sockRef, msg, '❌ Ye sirf owner kar sakta hai!');
                if (!args.length) return await sendMessage(sockRef, msg, '❌ Number daalo!\nExample: !addadmin 919876543210');
                const num = args[0].replace(/[^0-9]/g, '');
                adminList.add(num);
                await sendMessage(sockRef, msg, `✅ ${num} ko admin bana diya!`);
            }
        },
        deladmin: {
            adminOnly: true,
            handler: async (sockRef, msg, args, sender) => {
                if (sender !== CONFIG.ownerNumber + '@s.whatsapp.net') return await sendMessage(sockRef, msg, '❌ Ye sirf owner kar sakta hai!');
                if (!args.length) return await sendMessage(sockRef, msg, '❌ Number daalo!\nExample: !deladmin 919876543210');
                const num = args[0].replace(/[^0-9]/g, '');
                if (num === CONFIG.ownerNumber) return await sendMessage(sockRef, msg, '❌ Owner ko remove nahi kar sakte!');
                adminList.delete(num);
                await sendMessage(sockRef, msg, `✅ ${num} ko admin se hata diya!`);
            }
        },
        broadcast: {
            adminOnly: true,
            handler: async (sockRef, msg, args, sender) => {
                if (!isAdmin(sender)) return await sendMessage(sockRef, msg, '❌ Ye command sirf admin ke liye hai!');
                if (!args.length) return await sendMessage(sockRef, msg, '❌ Message likho!\nExample: !broadcast Hello sabko');
                const text = `📢 *Broadcast:*\n\n${args.join(' ')}`;
                let sent = 0;
                for (const jid of userHistory.keys()) {
                    try { await sockRef.sendMessage(jid, { text }); sent++; } catch (e) { /* skip */ }
                }
                await sendMessage(sockRef, msg, `✅ ${sent} logo ko bhej diya!`);
            }
        },
    };

    async function sendMessage(sockRef, msg, text) {
        await sockRef.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
    }

    async function handleMessage(sockRef, msg) {
        try {
            if (msg.key.fromMe) return;
            const sender = msg.key.remoteJid;
            const senderNum = msg.key.participant || sender;

            const imageMsg = msg.message?.imageMessage;
            if (imageMsg) {
                try {
                    await sockRef.sendMessage(sender, { text: '👁️ Image dekh raha hoon...' }, { quoted: msg });
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const base64 = buffer.toString('base64');
                    const mimeType = imageMsg.mimetype || 'image/jpeg';
                    const caption = imageMsg.caption || '';
                    const reply = await getImageAIReply(senderNum, base64, caption, mimeType);
                    await sendMessage(sockRef, msg, reply);
                } catch (err) {
                    await sendMessage(sockRef, msg, 'Bhai image process nahi ho paayi 😅');
                }
                return;
            }

            const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (!body) return;

            if (body.startsWith(CONFIG.prefix)) {
                const [cmdName, ...args] = body.slice(CONFIG.prefix.length).trim().split(' ');
                const command = commands[cmdName.toLowerCase()];
                if (command) {
                    await command.handler(sockRef, msg, args, senderNum);
                } else {
                    await sendMessage(sockRef, msg, `Ye command nahi pata bhai 😅\nType *${CONFIG.prefix}help* for all commands.`);
                }
                return;
            }

            const aiReply = await getAIReply(senderNum, body);
            await sendMessage(sockRef, msg, aiReply);

        } catch (err) {
            console.error(`[${CONFIG.botName}] handleMessage error:`, err.message);
        }
    }

    // ============================================
    // START / STOP — website ke Start/Stop buttons yahi call karte hain
    // ============================================
    async function start() {
        const credsPath = path.join(CONFIG.sessionDir, 'creds.json');
        if (!fs.existsSync(credsPath)) {
            throw new Error('creds.json nahi mila. Pehle apna session file upload karo.');
        }

        stoppedByUser = false;
        setStatus('connecting');

        const { version } = await fetchLatestBaileysVersion();
        const { state: authState, saveCreds } = await useMultiFileAuthState(CONFIG.sessionDir);

        sock = makeWASocket({
            version,
            auth: authState,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                setStatus('connected');
                if (callbacks.onConnected) callbacks.onConnected();
            }

            if (connection === 'close') {
                if (stoppedByUser) {
                    setStatus('stopped');
                    return;
                }
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== DisconnectReason.loggedOut) {
                    setStatus('reconnecting');
                    setTimeout(() => {
                        if (!stoppedByUser) start().catch(err => {
                            setStatus('error');
                            if (callbacks.onError) callbacks.onError(err.message);
                        });
                    }, 3000);
                } else {
                    setStatus('logged_out');
                    if (callbacks.onError) callbacks.onError('WhatsApp se logout ho gaya — naya creds.json upload karke dubara start karo.');
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) await handleMessage(sock, msg);
        });

        return sock;
    }

    async function stop() {
        stoppedByUser = true;
        if (sock) {
            try { sock.end(undefined); } catch (e) { /* already closed */ }
        }
        setStatus('stopped');
    }

    function getStatus() {
        return status;
    }

    return { start, stop, getStatus, CONFIG };
}

module.exports = { createBot };
