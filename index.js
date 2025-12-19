import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// === WA Webhook verify token (isi sama di dashboard webhook) ===
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// === WA Cloud API (Graph) ===
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v20.0";

// === Gemini ===
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// --- health checks ---
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// --- 1) Webhook verification (GET) ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- helper: panggil Gemini ---
async function askGemini(text) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Gemini error ${r.status}: ${t}`);
  }

  const data = await r.json();
  const reply =
    data?.candidates?.[0]?.content?.parts
      ?.map(p => p.text)
      .filter(Boolean)
      .join("")
      ?.trim() || "Maaf, aku belum bisa menjawab itu.";

  return reply;
}

// --- helper: kirim WA text via Graph API ---
async function sendWhatsAppText(to, text) {
  if (!WA_PHONE_NUMBER_ID) throw new Error("Missing WA_PHONE_NUMBER_ID");
  if (!WA_ACCESS_TOKEN) throw new Error("Missing WA_ACCESS_TOKEN");

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(WA_PHONE_NUMBER_ID)}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text }
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`
    },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`WA send error ${r.status}: ${t}`);
  }
  return r.json();
}

// --- dedupe sederhana (hindari balas dobel kalau webhook retry) ---
const seen = new Map();
function isDuplicate(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, exp] of seen.entries()) if (exp <= now) seen.delete(k);

  if (seen.has(id)) return true;
  seen.set(id, now + 5 * 60 * 1000);
  return false;
}

// --- 2) Webhook receiver (POST) ---
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const messages = value?.messages;
    if (!messages?.length) return res.sendStatus(200);

    const msg = messages[0];
    const from = msg.from;
    const msgId = msg.id;

    if (isDuplicate(msgId)) return res.sendStatus(200);

    let userText = "";
    if (msg.type === "text") userText = msg.text?.body || "";
    else userText = `User mengirim ${msg.type}. (Bot ini sementara hanya balas text)`;

    if (!from || !userText.trim()) return res.sendStatus(200);

    const reply = await askGemini(userText);
    await sendWhatsAppText(from, reply);

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    // tetap 200 supaya WA tidak retry berulang
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
