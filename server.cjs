// server.cjs – AERO LITE (AI-powered, LMS-only, 0.20% fee)
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// Helper to format money safely
function money(x) {
return Number.isFinite(x) ? Number(x.toFixed(2)) : 0;
}

// Healthcheck
app.get("/", (req, res) => {
res.json({ ok: true, service: "loadit-aero-lite-lms-only" });
});

// ========== AI Routing Simulator (AERO, LMS-only Loadit rail) ==========
app.post("/api/ai-routing-sim", async (req, res) => {
try {
const { from, to, amountUsd, assetPreference } = req.body || {};
const amount = parseFloat(amountUsd || "0") || 0;

if (!from || !to) {
return res.status(400).json({ error: "from and to are required" });
}
if (amount <= 0) {
return res.status(400).json({ error: "amountUsd must be > 0" });
}

if (!process.env.OPENAI_API_KEY) {
return res
.status(500)
.json({ error: "OPENAI_API_KEY is not set on the server" });
}

const userAsset = (assetPreference || "").toString();

// --- Call OpenAI to propose generic non-Loadit routes ---
const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
temperature: 0.4,
messages: [
{
role: "system",
content:
"You are Loadit's AERO routing engine. " +
"Given a cross-border transfer, your job is to design several realistic payment routes " +
"and reason carefully about which rails are likely the CHEAPEST, the FASTEST, and the MOST SECURE.\n\n" +
"You know about: traditional bank wires, card-based remittance services, centralized exchanges, " +
"on-chain stablecoin transfers, and P2P/crypto rails.\n\n" +
"IMPORTANT:\n" +
"- You DO NOT design 'Loadit' or 'LMS' rails; the backend will add those.\n" +
"- You ONLY describe legacy/standard rails and crypto/exchange rails.\n" +
"- For each route, estimate realistic feeUsd and feePercent based on typical market ranges.\n" +
"- In 'notes', explicitly mention if a route is mainly CHEAPEST, or FASTEST, or SECURITY-FOCUSED if applicable.\n\n" +
"Return STRICT JSON ONLY with this schema:\n" +
"{\n" +
' "routes": [\n' +
" {\n" +
' "name": string,\n' +
' "type": "bank" | "remittance" | "exchange" | "p2p" | "other",\n' +
' "isLoadit": boolean,\n' +
' "isBest": boolean,\n' +
' "feeUsd": number,\n' +
' "feePercent": number,\n' +
' "speed": string,\n' +
' "notes": string\n' +
" }\n" +
" ],\n" +
' "summary": string\n' +
"}\n\n" +
"Rules:\n" +
"- Do NOT mark any route as Loadit or LMS.\n" +
"- isLoadit should always be false in your output.\n" +
"- isBest can be true for one legacy route you think is 'best' WITHOUT Loadit.\n" +
"- feePercent must be between 0 and 25.\n" +
"- feeUsd must be >= 0.\n" +
"- Base your numbers on realistic averages (no live FX/gas).",
},
{
role: "user",
content:
`User wants to send about $${amount.toFixed(
2
)} from ${from} to ${to}. ` +
`Preferred asset (if any): ${userAsset || "none"}. ` +
"Design 3–5 plausible routes using different rails. Follow the JSON schema exactly.",
},
],
});

const rawContent = completion.choices?.[0]?.message?.content || "{}";

let parsed;
try {
parsed = JSON.parse(rawContent);
} catch (e) {
console.error("AERO JSON parse error:", rawContent);

// === Simple fallback if AI JSON breaks ===
const bankFlat = 35;
const bankFeeUsd = money(Math.max(bankFlat, amount * 0.002)); // ~0.2%
const bankFeePct = money((bankFeeUsd / amount) * 100);

const remitPct = 5.0;
const remitFeeUsd = money((remitPct / 100) * amount);

const exPct = 1.2;
const exFeeUsd = money((exPct / 100) * amount);

let lmsFeeUsd = money(amount * 0.002); // 0.20%
if (amount <= 100) {
lmsFeeUsd = money(lmsFeeUsd + 0.5);
}
const lmsPct = money((lmsFeeUsd / amount) * 100);

return res.json({
routes: [
{
name: "Traditional Bank Transfer",
type: "bank",
isLoadit: false,
isBest: false,
feeUsd: bankFeeUsd,
feePercent: bankFeePct,
speed: "2–5 business days",
notes:
"Fallback route. Legacy bank wire with flat fees and FX margin on top.",
},
{
name: "Card-Based Remittance Service",
type: "remittance",
isLoadit: false,
isBest: false,
feeUsd: remitFeeUsd,
feePercent: remitPct,
speed: "Minutes to a few hours",
notes:
"Fallback route. Typical remittance app with FX spread and service fees.",
},
{
name: "Centralized Exchange Transfer",
type: "exchange",
isLoadit: false,
isBest: false,
feeUsd: exFeeUsd,
feePercent: exPct,
speed: "Minutes to a few hours",
notes:
"Fallback route. Exchange-based transfer including trading, spread, and withdrawal costs.",
},
{
name: "Loadit Money Service (LMS Rail)",
type: "lms",
isLoadit: true,
isBest: true,
feeUsd: lmsFeeUsd,
feePercent: lmsPct,
speed: "Instant to ~1 hour",
notes:
"Recommended route – LMS uses modern rails and stablecoin-style settlement with a 0.20% platform fee, plus a small $0.50 buffer for transfers ≤ $100. Designed to beat legacy providers on both cost and speed.",
},
],
summary:
"Fallback static routes because the AI router JSON could not be parsed. Try again for more detailed options.",
});
}

const aiRoutes = Array.isArray(parsed.routes) ? parsed.routes : [];

// --- Normalize AI routes (NON-Loadit only) ---
const normalized = aiRoutes.slice(0, 6).map((r) => {
let name = (r.name || "Unnamed route").toString();
let type = (r.type || "other").toString();
let isLoadit = false;
let isBest = false; // we ignore AI's 'best' because LMS will be best in our UI
let speed = (r.speed || "").toString();
let notes = (r.notes || "").toString();
let feeUsd = Math.max(0, Number(r.feeUsd) || 0);
let feePercent = Number(r.feePercent) || 0;

if (feePercent < 0) feePercent = 0;
if (feePercent > 25) feePercent = 25;

const lowerName = name.toLowerCase();
const lowerType = type.toLowerCase();

// --- Bank normalization ---
if (lowerType === "bank" || lowerName.includes("bank")) {
const bankFlat = 35;
feeUsd = money(Math.max(bankFlat, amount * 0.002)); // ~0.2%
feePercent = money((feeUsd / amount) * 100);
if (!speed) speed = "2–5 business days";
if (!notes) {
notes =
"Legacy bank transfer using SWIFT-style rails with flat fees and FX margin on top.";
}
type = "bank";
}

// --- Remittance normalization ---
if (lowerType === "remittance" || lowerName.includes("remit")) {
let remitPct = 4.5;
if (amount < 300) remitPct = 6.5;
else if (amount > 5000) remitPct = 3.0;
feeUsd = money((remitPct / 100) * amount);
feePercent = money(remitPct);
if (!speed) speed = "Minutes to a few hours";
if (!notes) {
notes =
"Card-based remittance rail with typical FX and service markups in the 3–7% range.";
}
type = "remittance";
}

// --- Exchange normalization ---
if (lowerType === "exchange" || lowerName.includes("exchange")) {
let exPct = 1.0;
if (amount < 300) exPct = 1.5;
else if (amount > 10000) exPct = 0.8;
feeUsd = money((exPct / 100) * amount);
feePercent = money(exPct);
speed = "Minutes to a few hours";
if (!notes) {
notes =
"Centralized exchange transfer including trading fees, spread, and withdrawal fees.";
}
type = "exchange";
}

if (!speed) {
speed = "Unknown – varies by provider";
}

return {
name,
type,
isLoadit,
isBest,
feeUsd: money(feeUsd),
feePercent: money(feePercent),
speed,
notes,
};
});

// --- Synthetic Western Union + MoneyGram rails (legacy baselines) ---
const wuPct = 7.0;
const wuFeeUsd = money((wuPct / 100) * amount);
const wuRoute = {
name: "Western Union (Legacy Rail)",
type: "remittance",
isLoadit: false,
isBest: false,
feeUsd: wuFeeUsd,
feePercent: money(wuPct),
speed: "Minutes to a few hours",
notes:
"Traditional money transfer provider with high FX margins and service fees, often around 6–12% all-in.",
};

const mgPct = 6.0;
const mgFeeUsd = money((mgPct / 100) * amount);
const mgRoute = {
name: "MoneyGram (Legacy Rail)",
type: "remittance",
isLoadit: false,
isBest: false,
feeUsd: mgFeeUsd,
feePercent: money(mgPct),
speed: "Minutes to a few hours",
notes:
"Legacy remittance provider with card and cash pickup options, typically around 5–10% total cost.",
};

// --- LMS Rail (Loadit-only, 0.20% + $0.50 if ≤ $100) ---
let lmsFeeUsd = money(amount * 0.002); // 0.20%
if (amount <= 100) {
lmsFeeUsd = money(lmsFeeUsd + 0.5);
}
const lmsPct = money((lmsFeeUsd / amount) * 100);

const lmsRoute = {
name: "Loadit Money Service (LMS Rail)",
type: "lms",
isLoadit: true,
isBest: true, // Recommended route
feeUsd: lmsFeeUsd,
feePercent: lmsPct,
speed: "Instant to ~1 hour",
notes:
"Recommended route – AERO chooses the cheapest, fastest, secure mix of rails under the hood. LMS exposes that as a single 0.20% platform fee (plus a small $0.50 buffer for transfers ≤ $100), designed to beat Western Union, MoneyGram, and exchanges on both cost and speed.",
};

const finalRoutes = [...normalized, wuRoute, mgRoute, lmsRoute];

return res.json({
routes: finalRoutes,
summary:
parsed.summary ||
`AERO simulated multiple rails from ${from} to ${to}. LMS is modeled as the cheapest modern option (~0.20% fee plus a small buffer on small transfers).`,
});
} catch (err) {
console.error("AI Routing Simulator (LMS-only) error:", err);
return res
.status(500)
.json({ error: "Failed to simulate routes with OpenAI." });
}
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
console.log("AERO LITE (AI + LMS-only) running on port", PORT);
});
