// server.cjs – AERO LITE (AI Routing Simulator with LMS, WU, MG)
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// Helper to format money
function money(x) {
return Number.isFinite(x) ? Number(x.toFixed(2)) : 0;
}

// Healthcheck
app.get("/", (req, res) => {
res.json({ ok: true, service: "loadit-aero-lite" });
});

// ========== AI Routing Simulator (AERO preview) ==========
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

// --- Call OpenAI to propose generic routes (we'll normalize + add our own rails) ---
const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
temperature: 0.4,
messages: [
{
role: "system",
content:
"You are Loadit's AERO routing planner. " +
"Given a cross-border transfer, you design 3–4 possible payment routes. " +
"You know about: traditional bank wires, card-based remittance services, " +
"centralized exchanges, on-chain crypto transfers, stablecoins, and a special 'Loadit hybrid' rail " +
"that turns cash/card into crypto and settles on-chain.\n\n" +
"You DO NOT use live FX or live gas data. You just use typical patterns.\n\n" +
"Return STRICT JSON only with this schema:\n" +
"{\n" +
' \"routes\": [\n' +
" {\n" +
' \"name\": string,\n' +
' \"type\": \"bank\" | \"remittance\" | \"exchange\" | \"loadit-hybrid\" | \"p2p\" | \"other\",\n' +
' \"isLoadit\": boolean,\n' +
' \"isBest\": boolean,\n' +
' \"feeUsd\": number,\n' +
' \"feePercent\": number,\n' +
' \"speed\": string,\n' +
' \"notes\": string\n' +
" }\n" +
" ],\n" +
' \"summary\": string\n' +
"}\n\n" +
"Rules:\n" +
"- feePercent must be between 0 and 25.\n" +
"- feeUsd must be >= 0.\n" +
"- At least one route MUST be a 'loadit-hybrid' with isLoadit=true.\n" +
"- For Loadit hybrid routes, assume roughly a 0.75% platform fee plus a small dynamic network fee " +
"(total usually between 0.85% and 1.0%, rarely up to ~1.2% in extreme conditions).\n" +
"- Typical speeds:\n" +
" * Bank wires: 2–5 business days\n" +
" * Card-based remittance: minutes to a few hours\n" +
" * Centralized exchange transfers: minutes to a few hours\n" +
" * Loadit hybrid rail: minutes to within ~1 hour\n" +
"- Mark exactly ONE route as isBest=true (the one you'd recommend).\n" +
"- Base your numbers on realistic but rough averages for today's remittance/crypto landscape, NOT on live data.",
},
{
role: "user",
content:
`User wants to send about $${amount.toFixed(
2
)} from ${from} to ${to}. ` +
`Preferred asset (if any): ${userAsset || "none"}. ` +
"Design 3–4 plausible routes with different rails and fee structures " +
"and follow the JSON schema exactly.",
},
],
});

const rawContent = completion.choices?.[0]?.message?.content || "{}";

let parsed;
try {
parsed = JSON.parse(rawContent);
} catch (e) {
console.error("AERO JSON parse error:", rawContent);

// Very simple fallback routes if AI JSON blows up
const bankFlat = 35; // example flat wire fee
const bankFeeUsd = money(Math.max(bankFlat, amount * 0.002)); // ~0.2% min
const platformPct = 0.75;
const networkPct = 0.15;
const loaditHybridPct = platformPct + networkPct;
const loaditHybridFeeUsd = money((loaditHybridPct / 100) * amount);

// LMS: 0.30% + $0.50 if <= 100
let lmsFeeUsd = money(amount * 0.003);
if (amount <= 100) {
lmsFeeUsd = money(lmsFeeUsd + 0.5);
}
const lmsPct = money((lmsFeeUsd / amount) * 100);

return res.json({
routes: [
{
name: "Traditional bank transfer",
type: "bank",
isLoadit: false,
isBest: false,
feeUsd: bankFeeUsd,
feePercent: money((bankFeeUsd / amount) * 100),
speed: "2–5 business days",
notes:
"Fallback route. Legacy bank wire using SWIFT-style rails with flat and FX costs.",
},
{
name: "Loadit hybrid rail",
type: "loadit-hybrid",
isLoadit: true,
isBest: false,
feeUsd: loaditHybridFeeUsd,
feePercent: money(loaditHybridPct),
speed: "Minutes to ~1 hour",
notes:
"Fallback Loadit crypto rail modeled as ~0.75% platform fee plus ~0.15% estimated network fee.",
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
"Recommended route. LMS uses AI-optimized stablecoin settlement with a 0.30% fee plus a small $0.50 buffer for transfers ≤ $100. Lowest overall fee and fastest typical delivery.",
},
],
summary:
"Fallback static routes because the AI router JSON could not be parsed. Try again for more detailed options.",
});
}

const routes = Array.isArray(parsed.routes) ? parsed.routes : [];

// --- Normalize AI routes & apply realistic fees per type ---
const normalized = routes.slice(0, 6).map((r) => {
let name = (r.name || "Unnamed route").toString();
let type = (r.type || "other").toString();
let isLoadit = Boolean(r.isLoadit);
let isBest = Boolean(r.isBest);
let speed = (r.speed || "").toString();
let notes = (r.notes || "").toString();
let feeUsd = Math.max(0, Number(r.feeUsd) || 0);
let feePercent = Number(r.feePercent) || 0;

// Clamp insane values
if (feePercent < 0) feePercent = 0;
if (feePercent > 25) feePercent = 25;

// --- Bank transfer normalization ---
if (type === "bank" || name.toLowerCase().includes("bank")) {
const baseFlat = 35; // typical SWIFT fee
feeUsd = money(Math.max(baseFlat, amount * 0.002)); // ~0.2% minimum
feePercent = money((feeUsd / amount) * 100);
if (!speed) speed = "2–5 business days";
if (!notes) {
notes =
"Legacy bank transfer using SWIFT-style rails with flat fees and FX margin on top.";
}
}

// --- Generic remittance normalization (non-Loadit) ---
if (type === "remittance") {
// Typical 3–7%
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
}

// --- Centralized exchange normalization ---
if (
type === "exchange" ||
name.toLowerCase().includes("exchange")
) {
// 0.8–1.5% typical all-in
let exPct = 1.0;
if (amount < 300) exPct = 1.5;
else if (amount > 10000) exPct = 0.8;
feeUsd = money((exPct / 100) * amount);
feePercent = money(exPct);
speed = "Minutes to a few hours"; // no more 'within 1 day'
if (!notes) {
notes =
"Centralized exchange transfer including trading fees, spread, and withdrawal fees.";
}
}

// --- Loadit hybrid rail normalization (~1% total) ---
if (isLoadit || type === "loadit-hybrid") {
const platformPct = 0.75;
let networkPct;
if (amount <= 300) {
networkPct = 0.10;
} else if (amount <= 2000) {
networkPct = 0.15;
} else {
networkPct = 0.25;
}
const totalPct = platformPct + networkPct;
feeUsd = money((totalPct / 100) * amount);
feePercent = money(totalPct);
if (!speed || speed.toLowerCase().includes("day")) {
speed = "Minutes to ~1 hour";
}
notes =
(notes ? notes + " " : "") +
`Modeled as ~${platformPct.toFixed(
2
)}% platform fee + ~${networkPct.toFixed(
2
)}% estimated network fee (total ~${totalPct.toFixed(2)}%).`;
isLoadit = true;
}

// Normalize any unknown types with fallback speed
if (!speed) speed = "Unknown – varies by provider";

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

// --- Add explicit Western Union + MoneyGram synthetic rails ---
const wuPct = 7.0; // 7% typical
const mgPct = 6.0; // 6% typical
const wuFeeUsd = money((wuPct / 100) * amount);
const mgFeeUsd = money((mgPct / 100) * amount);

const wuRoute = {
name: "Western Union (Legacy Rail)",
type: "remittance",
isLoadit: false,
isBest: false,
feeUsd: wuFeeUsd,
feePercent: money(wuPct),
speed: "Minutes to a few hours",
notes:
"Traditional money transfer provider with high FX margins and service fees, typically around 6–12% all-in.",
};

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

// --- Add LMS Rail (0.30% + $0.50 if ≤ $100) ---
let lmsFeeUsd = money(amount * 0.003);
if (amount <= 100) {
lmsFeeUsd = money(lmsFeeUsd + 0.5);
}
const lmsPct = money((lmsFeeUsd / amount) * 100);

const lmsRoute = {
name: "Loadit Money Service (LMS Rail)",
type: "lms",
isLoadit: true,
isBest: true, // Recommended + Lowest Fee
feeUsd: lmsFeeUsd,
feePercent: lmsPct,
speed: "Instant to ~1 hour",
notes:
"Recommended route – lowest fee and AI-optimized. LMS uses stablecoin settlement and intelligent routing with a 0.30% fee, plus a small $0.50 buffer for transfers ≤ $100. Designed to beat Western Union, MoneyGram, and exchanges on both cost and speed.",
};

// Clear any 'isBest' flags from other routes – LMS is the recommended one
const cleaned = normalized.map((r) => ({
...r,
isBest: false,
}));

// Compose final routes array
const finalRoutes = [
...cleaned,
wuRoute,
mgRoute,
lmsRoute,
];

return res.json({
routes: finalRoutes,
summary:
parsed.summary ||
"AERO simulated multiple rails including banks, legacy remittance, exchanges, Loadit hybrid, and Loadit Money Service (LMS).",
});
} catch (err) {
console.error("AI Routing Simulator error:", err);
return res
.status(500)
.json({ error: "Failed to simulate routes with OpenAI." });
}
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
console.log("AERO LITE running on port", PORT);
});
