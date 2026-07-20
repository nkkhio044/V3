# WhatsApp AI Bot — Multi-User Dashboard

Ab ye ek dashboard hai jahan **koi bhi** apna khud ka WhatsApp AI bot bana
sakta hai — apna `creds.json` upload karke, bot ka naam/bio set karke, aur
Start/Stop button se control karke. Har bot poori tarah alag chalta hai —
alag session, alag API key, alag admin list.

## Zaroori baat

Ye website hai, lekin isko chalane ke liye ek Node.js server chahiye (apne
laptop, VPS, ya Railway/Render jaisi hosting par) — kyunki har bot ek live
WhatsApp connection (Baileys) rakhta hai jo hamesha chalta rehna chahiye.

## Files

- `server.js` — dashboard serve karta hai, `/api/bots` se bots create/list/
  start/stop/delete hote hain, aur creds.json upload handle karta hai.
- `bot.js` — bot ka logic, ab ek factory function (`createBot`) hai taaki
  ek saath kayi bots alag-alag chal sakein.
- `public/index.html` — dashboard UI: bot cards + "Naya Bot Banao" form.
- `sessions/<botId>/creds.json` — har bot ka apna WhatsApp session file, jo
  upload karte waqt yahan save hota hai.
- `data/bots.json` — sab bots ki details (naam, owner number, bio, API key)
  yahan persist hoti hain, taaki server restart hone par bhi bots ki list
  bani rahe.

## Kaise chalayein

```bash
npm install
npm start
```

Browser me `http://localhost:3000` kholo:

1. **"+ Naya Bot Banao"** dabao.
2. Bot ka naam, owner ka naam, owner ka WhatsApp number, bio, aur prefix
   bharo.
3. Apna **creds.json** file upload karo (jahan se bhi tumhara WhatsApp
   session pehle se linked hai).
4. **API Key wale highlighted box me apni Anthropic API key daalo**
   ("👉 API KEY YAHAN DAALO").
5. "Bot Banao" dabao — bot card dashboard pe aa jayega.
6. Us card pe **Start** dabao — bot creds.json se WhatsApp se connect ho
   jayega. **Stop** dabao jab band karna ho.

Dashboard har 3 second me refresh hota hai, toh status (Connected/Stopped/
Error waghera) live update hota rehta hai.

## Dhyan rakhne wali baatein

- Har user ki apni `creds.json` aur apni API key sirf server par local
  files me save hoti hai — kisi doosre user ke bot se mix nahi hoti.
- `creds.json` sensitive hai — jiske paas ye file hai wo us WhatsApp number
  se messages bhej sakta hai. Sirf apna khud ka session upload karo, kisi
  aur ka nahi.
- "Stop" sirf connection band karta hai (logout nahi) — dubara "Start"
  dabaoge toh wahi session use hoke reconnect ho jayega.
- Agar WhatsApp se khud logout ho jaye (status "Logged out" dikhega), toh
  naya creds.json banake dubara upload karna padega — us bot ko delete
  karke naya bana lo.
- `song` command YouTube se scrape karta hai — agar YouTube page structure
  badal de to ye kaam karna band kar sakta hai, ye normal hai.
