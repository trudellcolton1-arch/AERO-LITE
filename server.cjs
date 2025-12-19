// server.cjs – AERO LITE (AI-powered, LMS + realistic fee logic)
// Users pay ONLY conversion fees when funding starts as cash/card (2%–8% band).
// Digital-to-digital routing is free for users.
// Optional 0.2% network routing cost may apply behind the scenes for business/platform delivery.

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

// Conversion fee band (user-paid) for cash/card → digital
function conversionFeeRateForAsset(assetPreference) {
const a = (assetPreference || "").toString().trim().toUpperCase();

// Your stated band:
// ~2% for SOL/XRP/USDC/USDT
// up to ~8% for BTC/ETH
if (["USDC", "USDT", "SOL", "XRP"].includes(a)) return 0.02;
if (["BTC", "ETH"].includes(a)) return 0.08;

// Default middle when unknown
return 0.04;
}

function clamp(n, min, max) {
return Math.max(min, Math.min(max, n));
}

// Healthcheck
app.get("/", (req, res) => {
res.json({ ok: true, service: "loadit-aero-lite" });
});

// ========== AI Routing Simulator (AERO) ==========
app.post("/api/ai-routing-sim", async (req, res) => {
try {
const {
from,
to,
amountUsd,
assetPreference,

// NEW (optional)
fundingSource, // "cash" | "card" | "digital"
demoAssumeDigital, // true/false
recipientType, // "personal" | "business" | "platform"
} = req.body || {};

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

// Normalize new inputs
const source = (fundingSource || "digital").toString().toLowerCase(); // cash | card | digital
const assumeDigital = demoAssumeDigital === undefined ? true : !!demoAssumeDigital;
const recipient = (recipientType || "personal").toString().toLowerCase(); // personal | business | platform

// --- USER FEES vs NETWORK COSTS ---
// Users only pay conversion when starting from cash/card and NOT assuming already-digital demo mode.
let userConversionRate = 0;
if (!assumeDigital && (source === "cash" || source === "card")) {
userConversionRate = conversionFeeRateForAsset(userAsset);
}

let userConversionFeeUsd = money(amount * userConversionRate);

// Optional small-transfer buffer (keep if you want)
if (!assumeDigital && (source === "cash" || source === "card") && amount <= 100) {
userConversionFeeUsd = money(userConversionFeeUsd + 0.5);
}

const userConversionFeePct = money((userConversionFeeUsd / amount) * 100);

// Network routing cost (NOT user-paid) – applied only for business/platform delivery
const networkRate = 0.002; // 0.20%
const appliesNetwork = (recipient === "business" || recipient === "platform");
const networkRoutingCostUsd = appliesNetwork ? money(amount * networkRate) : 0;
const networkRoutingCostPct = appliesNetwork ? 0.20 : 0;

// --- Call OpenAI to propose generic non-Loadit routes ---
const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
temperature: 0.4,
messages: [
{
role: "system",
content:
"You are Loadit's AERO routing engine. " +
"Given a cross-border transfer, design several realistic payment routes " +
"and reason carefully about which rails are likely the CHEAPEST and MOST PRACTICAL.\n\n" +
"You know about: traditional bank wires, card-based remittance services, centralized exchanges, " +
"on-chain stablecoin transfers, and P2P/crypto rails.\n\n" +
"IMPORTANT:\n" +
"- You DO NOT design 'Loadit' or 'LMS' rails; the backend will add those.\n" +
"- You ONLY describe legacy/standard rails and crypto/exchange rails.\n" +
"- For each route, estimate realistic feeUsd and feePercent based on typical market ranges.\n" +
"- In 'notes', mention tradeoffs, including extra off-ramp, cash-out, or withdrawal costs when relevant.\n\n" +
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
`User wants to send about $${amount.toFixed(2)} from ${from} to ${to}. ` +
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

// === Fallback static routes if AI JSON breaks ===
const bankFlat = 35;
const bankFeeUsd = money(Math.max(bankFlat, amount * 0.002)); // ~0.2% + flat
const bankFeePct = money((bankFeeUsd / amount) * 100);

const remitPct = amount < 300 ? 6.5 : amount > 5000 ? 3.0 : 4.5;
const remitFeeUsd = money((remitPct / 100) * amount);

const exPct = amount < 300 ? 1.5 : amount > 10000 ? 0.8 : 1.0;
const exFeeUsd = money((exPct / 100) * amount);

// Competitor totals (simplified)
const exTotal = exFeeUsd; // keeps fallback simple

// LMS / Loadit card
const lmsUserFeeUsd = userConversionFeeUsd; // what user pays
const lmsAllIn = money(lmsUserFeeUsd + networkRoutingCostUsd); // economic total (optional)

// Choose best by totalEstimatedCostUsd
const candidates = [
{ key: "bank", total: bankFeeUsd },
{ key: "remit", total: remitFeeUsd },
{ key: "ex", total: exTotal },
{ key: "lms", total: lmsAllIn },
];
const bestKey = candidates.sort((a, b) => a.total - b.total)[0]?.key;

return res.json({
routes: [
{
name: "Traditional Bank Wire Transfer",
type: "bank",
isLoadit: false,
isBest: bestKey === "bank",
feeUsd: bankFeeUsd,
feePercent: bankFeePct,
speed: "2–5 business days",
notes:
"Legacy bank wire with flat fees and FX margin on top. Can be cheaper on large amounts but slow and less flexible.",
offRampLowUsd: null,
offRampMidUsd: null,
offRampHighUsd: null,
totalEstimatedCostUsd: bankFeeUsd,
},
{
name: "Card-Based Remittance Service (e.g., Western Union via Card)",
type: "remittance",
isLoadit: false,
isBest: bestKey === "remit",
feeUsd: remitFeeUsd,
feePercent: money(remitPct),
speed: "Minutes to a few hours",
notes:
"Card-based remittance with FX spread and service fees. Convenient but typically expensive.",
offRampLowUsd: null,
offRampMidUsd: null,
offRampHighUsd: null,
totalEstimatedCostUsd: remitFeeUsd,
},
{
name: "Centralized Crypto Exchange Transfer",
type: "exchange",
isLoadit: false,
isBest: bestKey === "ex",
feeUsd: exFeeUsd,
feePercent: money(exPct),
speed: "Minutes to a few hours",
notes:
"Exchange-based transfer. Headline fees can look low but real cost rises with spreads, withdrawal, and off-ramp friction.",
offRampLowUsd: null,
offRampMidUsd: null,
offRampHighUsd: null,
totalEstimatedCostUsd: exTotal,
},
{
name: "Loadit Money Service (LMS Rail)",
type: "lms",
isLoadit: true,
isBest: bestKey === "lms",

// What user pays:
feeUsd: lmsUserFeeUsd,
feePercent: userConversionFeePct,

// Behind-the-scenes economics (optional):
networkRoutingCostUsd,
networkRoutingCostPercent: networkRoutingCostPct,
networkPaidBy: appliesNetwork ? "business/platform" : "n/a",

// All-in estimate (economic total; user still only pays feeUsd)
allInEstimatedCostUsd: lmsAllIn,

speed: "Instant to ~1 hour",
notes:
"Loadit converts cash/card into final digital value (the only step users pay for), then routes via IoM and delivers the recipient’s preferred currency. " +
"Load fee applies only for cash/card funding. " + // ✅ ADDED LINE
"Digital-to-digital routing is free for users. " +
(appliesNetwork
? "A small 0.2% IoM network routing cost may apply behind the scenes for business/platform delivery."
: "No IoM network routing cost is applied in this scenario.") +
(assumeDigital
? " (Demo mode: value treated as already digitized.)"
: ""),
offRampLowUsd: null,
offRampMidUsd: null,
offRampHighUsd: null,
totalEstimatedCostUsd: lmsUserFeeUsd,
},
],
summary:
"Fallback static routes because the AI router JSON could not be parsed. " +
"Loadit is designed to minimize end-to-end cost by converting once and routing digitally via IoM. " +
"Best route is chosen by estimated total cost (not a guarantee).",
});
}

const aiRoutes = Array.isArray(parsed.routes) ? parsed.routes : [];

// --- Normalize AI routes (NON-Loadit only) ---
const normalized = aiRoutes.slice(0, 6).map((r) => {
let name = (r.name || "Unnamed route").toString();
let type = (r.type || "other").toString();
const isLoadit = false;
let isBest = false; // we'll recompute later
let speed = (r.speed || "").toString();
let notes = (r.notes || "").toString();
let feeUsd = Math.max(0, Number(r.feeUsd) || 0);
let feePercent = Number(r.feePercent) || 0;

// Off-ramp placeholders (for crypto rails)
let offRampLowUsd = null;
let offRampMidUsd = null;
let offRampHighUsd = null;

feePercent = clamp(feePercent, 0, 25);

const lowerName = name.toLowerCase();
const lowerType = type.toLowerCase();

// --- Bank normalization ---
if (lowerType === "bank" || lowerName.includes("bank")) {
const bankFlat = 35;
feeUsd = money(Math.max(bankFlat, amount * 0.002));
feePercent = money((feeUsd / amount) * 100);
if (!speed) speed = "2–5 business days";
if (!notes) {
notes =
"Legacy bank transfer with flat fees and FX margin. Can be cheaper on large amounts but slower and less flexible.";
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

// Model extra off-ramp friction (midpoint)
const midOffRampUsd = feeUsd;
const lowOffRampUsd = money(midOffRampUsd * 0.7);
const highOffRampUsd = money(midOffRampUsd * 1.3);

offRampLowUsd = lowOffRampUsd;
offRampMidUsd = midOffRampUsd;
offRampHighUsd = highOffRampUsd;

notes =
`Centralized crypto exchange transfer. Headline trading fees can look low, but once you include spreads, withdrawal fees, and fiat payout costs, the real money lost is higher.`;
type = "exchange";
}

// --- Stablecoin hints treated as exchange-like (off-ramp cost added) ---
const looksStable =
lowerName.includes("stable") ||
lowerName.includes("usdc") ||
lowerName.includes("usdt");

if (looksStable && lowerType !== "p2p") {
if (!speed) speed = "Minutes";
let withdrawPct;
if (amount < 500) withdrawPct = 1.5;
else if (amount < 5000) withdrawPct = 1.0;
else withdrawPct = 0.6;
const fixedOffRamp = 5;

const midWithdrawFeeUsd = money((withdrawPct / 100) * amount + fixedOffRamp);
const lowWithdrawFeeUsd = money(midWithdrawFeeUsd * 0.7);
const highWithdrawFeeUsd = money(midWithdrawFeeUsd * 1.3);

offRampLowUsd = lowWithdrawFeeUsd;
offRampMidUsd = midWithdrawFeeUsd;
offRampHighUsd = highWithdrawFeeUsd;

notes =
`On-chain stablecoin transfer can be fast, but most users still pay separate off-ramp/withdrawal costs to get back to fiat.`;
type = "exchange";
}

// --- P2P detection ---
const looksP2P =
lowerType === "p2p" ||
lowerName.includes("p2p") ||
lowerName.includes("localbitcoins") ||
lowerName.includes("otc");

if (looksP2P) {
if (!speed) speed = "Hours to 1 day";
type = "p2p";
}

if (!speed) speed = "Unknown – varies by provider";

const hasOffRamp = offRampMidUsd != null;

const totalEstimatedCostUsd = hasOffRamp
? money(feeUsd + offRampMidUsd)
: money(feeUsd);

return {
name,
type,
isLoadit,
isBest,
feeUsd: money(feeUsd),
feePercent: money(feePercent),
speed,
notes,
offRampLowUsd: hasOffRamp ? money(offRampLowUsd) : null,
offRampMidUsd: hasOffRamp ? money(offRampMidUsd) : null,
offRampHighUsd: hasOffRamp ? money(offRampHighUsd) : null,
totalEstimatedCostUsd,
};
});

// We don't want AI-created P2P routes (we'll add one clean P2P card ourselves)
const normalizedNonP2P = normalized.filter((r) => r.type !== "p2p");

// --- Synthetic P2P / OTC rail (single card) ---
let p2pPct;
if (amount < 500) p2pPct = 3.0;
else if (amount < 5000) p2pPct = 2.0;
else p2pPct = 1.2;

const fixedP2P = 8;
const midP2PFeeUsd = money((p2pPct / 100) * amount + fixedP2P);
const lowP2PFeeUsd = money(midP2PFeeUsd * 0.7);
const highP2PFeeUsd = money(midP2PFeeUsd * 1.3);

const p2pRoute = {
name: "P2P / OTC Crypto Transfer",
type: "p2p",
isLoadit: false,
isBest: false,
feeUsd: midP2PFeeUsd,
feePercent: money((midP2PFeeUsd / amount) * 100),
speed: "Hours to 1 day",
notes:
"P2P/OTC often looks cheap on-chain, but real-world cash-out spreads and markups raise total cost and risk.",
offRampLowUsd: lowP2PFeeUsd,
offRampMidUsd: midP2PFeeUsd,
offRampHighUsd: highP2PFeeUsd,
totalEstimatedCostUsd: midP2PFeeUsd,
};

// --- LMS / Loadit rail ---
const lmsUserFeeUsd = userConversionFeeUsd; // what user pays
const lmsUserFeePct = userConversionFeePct;
const lmsAllInEstimatedCostUsd = money(lmsUserFeeUsd + networkRoutingCostUsd);

const lmsRoute = {
name: "Loadit Money Service (LMS Rail)",
type: "lms",
isLoadit: true,
isBest: false, // computed below

// user-facing fee
feeUsd: lmsUserFeeUsd,
feePercent: lmsUserFeePct,

// behind-the-scenes economics (optional)
networkRoutingCostUsd,
networkRoutingCostPercent: networkRoutingCostPct,
networkPaidBy: appliesNetwork ? "business/platform" : "n/a",

// all-in economic estimate
allInEstimatedCostUsd: lmsAllInEstimatedCostUsd,

speed: "Instant to ~1 hour",
notes:
"Loadit converts cash/card into final digital value (the only step users pay for), then routes via IoM and delivers the recipient’s preferred currency. " +
"Load fee applies only for cash/card funding. " + // ✅ ADDED LINE
"Digital-to-digital routing is free for users. " +
(appliesNetwork
? "A small 0.2% IoM network routing cost may apply behind the scenes for business/platform delivery."
: "No IoM network routing cost is applied in this scenario.") +
(assumeDigital
? " (Demo mode: value treated as already digitized.)"
: ""),
offRampLowUsd: null,
offRampMidUsd: null,
offRampHighUsd: null,
totalEstimatedCostUsd: lmsUserFeeUsd,
};

// FINAL LIST: AI routes (no P2P), + ONE P2P card, + LMS
const finalRoutes = [...normalizedNonP2P, p2pRoute, lmsRoute];

// Pick best route by estimated TOTAL economic cost.
// For competitors, use totalEstimatedCostUsd.
// For Loadit, use allInEstimatedCostUsd (user fee + behind-the-scenes network cost when applicable).
let bestIdx = 0;
let bestCost = Infinity;

finalRoutes.forEach((r, idx) => {
const cost =
r.isLoadit
? (typeof r.allInEstimatedCostUsd === "number" ? r.allInEstimatedCostUsd : r.totalEstimatedCostUsd)
: r.totalEstimatedCostUsd;

if (cost < bestCost) {
bestCost = cost;
bestIdx = idx;
}
});

finalRoutes.forEach((r, idx) => (r.isBest = idx === bestIdx));

// Honest summary: "designed to beat" not "always"
const demoModeNote = assumeDigital
? "Demo mode assumes value is already digitized inside Loadit."
: `Funding source is ${source}; conversion fee applies only for cash/card (2%–8%).`;

return res.json({
routes: finalRoutes,
summary:
(parsed.summary ? parsed.summary + " " : "") +
`AERO compared routes from ${from} to ${to}. ${demoModeNote} ` +
`Loadit is designed to minimize total end-to-end cost by converting once and routing digitally via IoM, ` +
`but exact cheapest route can vary by amount and scenario.`,
meta: {
fundingSource: source,
demoAssumeDigital: assumeDigital,
recipientType: recipient,
userConversionFeeUsd,
userConversionFeePct,
networkRoutingCostUsd,
networkRoutingCostPct,
},
});
} catch (err) {
console.error("AI Routing Simulator error:", err);
return res.status(500).json({ error: "Failed to simulate routes with OpenAI." });
}
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
console.log("AERO LITE (AI + LMS) running on port", PORT);
});
