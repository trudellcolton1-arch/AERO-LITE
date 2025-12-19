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

// -------------------- HELPERS --------------------
function money(x) {
return Number.isFinite(x) ? Number(x.toFixed(2)) : 0;
}

function clamp(n, min, max) {
return Math.max(min, Math.min(max, n));
}

// Conversion fee band (user-paid) for cash/card → digital
function conversionFeeRateForAsset(assetPreference) {
const a = (assetPreference || "").toString().trim().toUpperCase();

// ~2% for fast/low-friction rails
if (["USDC", "USDT", "SOL", "XRP"].includes(a)) return 0.02;

// Up to ~8% for BTC/ETH
if (["BTC", "ETH"].includes(a)) return 0.08;

// Default middle
return 0.04;
}

// -------------------- HEALTHCHECK --------------------
app.get("/", (req, res) => {
res.json({ ok: true, service: "loadit-aero-lite" });
});

// ==================== AERO ROUTING SIM ====================
app.post("/api/ai-routing-sim", async (req, res) => {
try {
const {
from,
to,
amountUsd,
assetPreference,

// Optional controls
fundingSource, // "cash" | "card" | "digital"
demoAssumeDigital, // true/false
recipientType, // "personal" | "business" | "platform"
} = req.body || {};

const amount = parseFloat(amountUsd || "0") || 0;

if (!from || !to) return res.status(400).json({ error: "from and to are required" });
if (amount <= 0) return res.status(400).json({ error: "amountUsd must be > 0" });
if (!process.env.OPENAI_API_KEY) {
return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
}

// Normalize inputs
const source = (fundingSource || "digital").toLowerCase();
const assumeDigital = demoAssumeDigital === undefined ? true : !!demoAssumeDigital;
const recipient = (recipientType || "personal").toLowerCase();
const asset = (assetPreference || "").toString();

// ---------------- USER FEES ----------------
let userConversionRate = 0;
if (!assumeDigital && (source === "cash" || source === "card")) {
userConversionRate = conversionFeeRateForAsset(asset);
}

let userConversionFeeUsd = money(amount * userConversionRate);
if (!assumeDigital && (source === "cash" || source === "card") && amount <= 100) {
userConversionFeeUsd = money(userConversionFeeUsd + 0.5);
}

const userConversionFeePct = money((userConversionFeeUsd / amount) * 100);

// ---------------- NETWORK COST (NOT USER-PAID) ----------------
const networkRate = 0.002; // 0.20%
const appliesNetwork = recipient === "business" || recipient === "platform";
const networkRoutingCostUsd = appliesNetwork ? money(amount * networkRate) : 0;
const networkRoutingCostPct = appliesNetwork ? 0.2 : 0;

// ---------------- EXPLANATION BLOCKS ----------------
const loadFeeDisclosure =
"Load fee applies only when starting from cash or card. Digital-to-digital routing is free for users.";

const pricingModel = {
userPays: "Cash/Card conversion only",
conversionFee: "2%–8% when converting cash or card into digital value",
routingFee: "Free for users once value is digital",
networkCost: "0.2% paid by businesses/platforms (not users)",
};

const whyLoaditWins =
"Other services may advertise lower headline fees, but real-world total cost often rises due to FX spreads, " +
"withdrawal and off-ramp fees, cash-out friction, delays, and risk. Loadit converts once and routes digitally " +
"via the Internet of Money (IoM), minimizing total end-to-end cost.";

// ---------------- AI ROUTE GENERATION ----------------
const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
temperature: 0.4,
messages: [
{
role: "system",
content:
"You are Loadit's AERO routing engine. Design realistic legacy and crypto payment routes. " +
"Do NOT design Loadit/LMS rails. Return strict JSON only.",
},
{
role: "user",
content:
`Send $${amount.toFixed(2)} from ${from} to ${to}. Preferred asset: ${asset || "none"}.`,
},
],
});

let parsed;
try {
parsed = JSON.parse(completion.choices[0].message.content);
} catch {
parsed = { routes: [] };
}

// ---------------- NORMALIZE AI ROUTES ----------------
const normalized = (parsed.routes || []).slice(0, 5).map((r) => {
let feeUsd = Math.max(0, Number(r.feeUsd) || 0);
let feePercent = clamp(Number(r.feePercent) || 0, 0, 25);

return {
name: r.name,
type: r.type,
isLoadit: false,
isBest: false,
feeUsd: money(feeUsd),
feePercent: money(feePercent),
speed: r.speed || "Varies",
notes: r.notes || "",
totalEstimatedCostUsd: money(feeUsd),
};
});

// ---------------- LOADIT / LMS ROUTE ----------------
const lmsAllInEstimatedCostUsd = money(
userConversionFeeUsd + networkRoutingCostUsd
);

const lmsRoute = {
name: "Loadit Money Service (LMS Rail)",
type: "lms",
isLoadit: true,
isBest: false,

// User-facing
feeUsd: userConversionFeeUsd,
feePercent: userConversionFeePct,

// Behind-the-scenes
networkRoutingCostUsd,
networkRoutingCostPercent: networkRoutingCostPct,
networkPaidBy: appliesNetwork ? "business/platform" : "n/a",

allInEstimatedCostUsd: lmsAllInEstimatedCostUsd,

pricingModel,
whyLoaditWins,
loadFeeDisclosure,

speed: "Instant to ~1 hour",
notes:
"Loadit converts cash/card into digital value (only step users pay for), then routes via IoM " +
"and delivers the recipient’s preferred currency. " +
loadFeeDisclosure +
(assumeDigital ? " (Demo mode: value already digital.)" : ""),
totalEstimatedCostUsd: userConversionFeeUsd,
};

// ---------------- PICK BEST ROUTE ----------------
const allRoutes = [...normalized, lmsRoute];

let bestIdx = 0;
let bestCost = Infinity;

allRoutes.forEach((r, i) => {
const cost = r.isLoadit ? r.allInEstimatedCostUsd : r.totalEstimatedCostUsd;
if (cost < bestCost) {
bestCost = cost;
bestIdx = i;
}
});

allRoutes.forEach((r, i) => (r.isBest = i === bestIdx));

return res.json({
routes: allRoutes,
summary:
`AERO compared routes from ${from} to ${to}. ` +
(assumeDigital
? "Demo assumes value is already digital. "
: "Cash/card conversion fee applies. ") +
"Loadit minimizes total end-to-end cost by converting once and routing digitally via IoM.",
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
console.error(err);
res.status(500).json({ error: "AERO simulation failed" });
}
});

// -------------------- START --------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
console.log("AERO LITE running on port", PORT);
});
