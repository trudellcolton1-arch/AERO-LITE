// server.cjs – AERO LITE (AI Routing Simulator)
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
"- For Loadit hybrid routes, assume roughly a 1% platform fee plus a small dynamic network fee " +
"(total usually between 1.1% and 1.6%, rarely up to ~2% in extreme conditions).\n" +
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

// Fallback: very simple deterministic routes
const bankFeeUsd = money(amount * 0.07); // ~7%
const loaditPlatformPct = 1.0;
const loaditNetworkPct = 0.25; // ~0.25% network
const loaditTotalPct = loaditPlatformPct + loaditNetworkPct;
const loaditFeeUsd = money((loaditTotalPct / 100) * amount);

return res.json({
routes: [
{
name: "Traditional bank wire",
type: "bank",
isLoadit: false,
isBest: false,
feeUsd: bankFeeUsd,
feePercent: money((bankFeeUsd / amount) * 100),
speed: "2–5 business days",
notes:
"Fallback route. Bank wires are usually slower with higher FX and flat fees.",
},
{
name: "Loadit hybrid rail",
type: "loadit-hybrid",
isLoadit: true,
isBest: true,
feeUsd: loaditFeeUsd,
feePercent: money(loaditTotalPct),
speed: "Minutes to ~1 hour",
notes:
"Fallback route modeled as ~1.0% platform fee plus ~0.25% estimated network fee.",
},
],
summary:
"Fallback static routes because the AI router JSON could not be parsed. Try again for more detailed options.",
});
}

const routes = Array.isArray(parsed.routes) ? parsed.routes : [];

const cleanedRoutes = routes.slice(0, 6).map((r) => {
let feeUsd = Math.max(0, Number(r.feeUsd) || 0);
let feePercent = Number(r.feePercent) || 0;
if (feePercent < 0) feePercent = 0;
if (feePercent > 25) feePercent = 25;

let name = (r.name || "Unnamed route").toString();
let type = (r.type || "other").toString();
let isLoadit = Boolean(r.isLoadit);
let isBest = Boolean(r.isBest);
let speed = (r.speed || "unknown").toString();
let notes = (r.notes || "").toString();

// 🔥 Option C + D: override Loadit hybrid pricing:
// 1% platform fee + dynamic network fee based on amount
if (isLoadit || type === "loadit-hybrid") {
const platformPct = 1.0;

let networkPct;
if (amount <= 300) {
networkPct = 0.15; // small payment lane
} else if (amount <= 2000) {
networkPct = 0.25; // medium payment lane
} else {
networkPct = 0.35; // large payment lane
}

const totalPct = platformPct + networkPct;
feeUsd = money((totalPct / 100) * amount);
feePercent = money(totalPct);

notes =
notes +
(notes ? " " : "") +
`Modeled as ~${platformPct.toFixed(
2
)}% platform fee + ~${networkPct.toFixed(
2
)}% estimated network fee (total ~${totalPct.toFixed(2)}%).`;
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

if (!cleanedRoutes.length) {
return res.json({
routes: [],
summary: parsed.summary || "No routes found.",
});
}

return res.json({
routes: cleanedRoutes,
summary: parsed.summary || "",
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
