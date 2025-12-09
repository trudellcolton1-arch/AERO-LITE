onst express = require("express");
const cors = require("cors");
const multer = require("multer");
const OpenAI = require("openai");

const app = express();
const upload = multer();

app.use(cors());
app.use(express.json());

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

const CHEAP_ASSETS = ["SOL", "XRP", "USDC", "USDT"];

function money(x) {
return Number.isFinite(x) ? Number(x.toFixed(2)) : 0;
}

app.get("/", (req, res) => {
res.json({ ok: true, service: "loadit-ai-tools-openai" });
});

//
// ========== 1) AI FEE KILLER (receipt / on-ramp scanner) ==========
//
app.post("/api/ai-fee-killer", upload.single("image"), async (req, res) => {
try {
const { amountUsd, asset = "" } = req.body;

if (!req.file) {
return res.status(400).json({ error: "No image uploaded." });
}

const hintedAmount = parseFloat(amountUsd || "0") || 0;
const assetSymbol = asset.toUpperCase().trim() || "UNKNOWN";

if (!process.env.OPENAI_API_KEY) {
return res
.status(500)
.json({ error: "OPENAI_API_KEY is not set on the server" });
}

const base64 = req.file.buffer.toString("base64");
const mime = req.file.mimetype || "image/png";
const dataUrl = `data:${mime};base64,${base64}`;

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
temperature: 0,
messages: [
{
role: "system",
content:
"You are a STRICT receipt and fee extraction engine. " +
"You ONLY read what is printed in the screenshot. Do NOT guess or infer hidden FX markups. " +
"Return JSON only, no markdown. Use this exact schema:\n\n" +
"{\n" +
' "amount_paid_usd": number,\n' +
' "explicit_fee_usd": number,\n' +
' "explicit_fee_percent": number,\n' +
' "fee_lines": [ { "label": string, "amount_usd": number } ],\n' +
' "notes": string\n' +
"}\n\n" +
"If you see no fees at all, set explicit_fee_usd = 0 and explicit_fee_percent = 0 and explain that no fee lines were visible.",
},
{
role: "user",
content: [
{
type: "text",
text:
"Extract the amounts and fees from this crypto on-ramp / ATM / receipt image. " +
"Remember: JSON only.",
},
{
type: "image_url",
image_url: {
url: dataUrl,
detail: "high",
},
},
],
},
],
});

const rawContent = completion.choices?.[0]?.message?.content || "{}";

let parsed;
try {
parsed = JSON.parse(rawContent);
} catch (e) {
console.error("OpenAI JSON parse error:", rawContent);
return res.status(500).json({
error: "OpenAI Vision did not return valid JSON.",
detail: "parse_error",
});
}

const amountPaidUsd = Number(parsed.amount_paid_usd) || 0;
const explicitFeeUsd = Number(parsed.explicit_fee_usd) || 0;
const explicitFeePercent = Number(parsed.explicit_fee_percent) || 0;
const feeLines = Array.isArray(parsed.fee_lines) ? parsed.fee_lines : [];
const notes = (parsed.notes || "").toString();

const effectiveAmountUsd = amountPaidUsd > 0 ? amountPaidUsd : hintedAmount;

let totalFeeUsd = explicitFeeUsd;
let totalFeePercent = explicitFeePercent;

if (totalFeeUsd > 0 && totalFeePercent === 0 && effectiveAmountUsd > 0) {
totalFeePercent = (totalFeeUsd / effectiveAmountUsd) * 100;
}

if (totalFeeUsd < 0) totalFeeUsd = 0;
if (totalFeePercent < 0) totalFeePercent = 0;
if (totalFeePercent > 80) totalFeePercent = 80;

const loaditPercent =
effectiveAmountUsd > 0 && CHEAP_ASSETS.includes(assetSymbol) ? 2 : 8;
const loaditFeeUsd =
effectiveAmountUsd > 0 ? (loaditPercent / 100) * effectiveAmountUsd : 0;

const breakdown = [];
if (feeLines.length > 0) {
feeLines.forEach((f) => {
const label = (f.label || "Fee").toString();
const amt = Number(f.amount_usd) || 0;
breakdown.push(`${label} (~$${money(amt)})`);
});
} else if (totalFeeUsd > 0) {
breakdown.push(`Fees (~$${money(totalFeeUsd)})`);
}

const responseBody = {
asset: assetSymbol,
amountUsd: money(effectiveAmountUsd),
totalFee: money(totalFeeUsd),
feePercent: money(totalFeePercent),
loaditMinPercent: loaditPercent,
loaditMaxPercent: loaditPercent,
loaditMinFee: money(loaditFeeUsd),
loaditMaxFee: money(loaditFeeUsd),
breakdown,
comment:
notes ||
"Estimated total fee based only on visible fee lines. Hidden FX markups are not included.",
rawExtraction: parsed,
};

return res.json(responseBody);
} catch (err) {
console.error("AI Fee Killer error:", err);
return res
.status(500)
.json({ error: "Failed to analyze receipt image with OpenAI Vision." });
}
});

//
// ========== 2) AI ROUTING SIMULATOR (AERO preview) ==========
//
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
"that turns cash/card into crypto with ~2–8% total fees. " +
"You DO NOT use live FX or live gas data. You just use typical patterns. " +
"Return STRICT JSON only with this schema:\n\n" +
"{\n" +
' "routes": [\n' +
" {\n" +
' "name": string,\n' +
' "type": "bank" | "remittance" | "exchange" | "loadit-hybrid" | "p2p" | "other",\n' +
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
"- feePercent must be between 0 and 25.\n" +
"- feeUsd must be >= 0.\n" +
"- At least one route MUST be a 'loadit-hybrid' with isLoadit=true. " +
"For that route, keep feePercent typically between 2 and 8.\n" +
"- Mark exactly ONE route as isBest=true (the one you'd recommend).\n" +
"- Base your numbers on realistic but rough averages for today's remittance/crypto landscape, NOT on any live data.",
},
{
role: "user",
content:
`User wants to send about $${amount.toFixed(2)} from ${from} to ${to}. ` +
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

// Fallback: simple deterministic routes
const baseFeeBank = money(amount * 0.07); // ~7%
const baseFeeLoadit = money(amount * 0.03); // ~3%

return res.json({
routes: [
{
name: "Traditional bank wire",
type: "bank",
isLoadit: false,
isBest: false,
feeUsd: baseFeeBank,
feePercent: money((baseFeeBank / amount) * 100),
speed: "2–5 business days",
notes:
"Fallback example. Bank wires are usually slower with higher FX and flat fees.",
},
{
name: "Loadit hybrid route",
type: "loadit-hybrid",
isLoadit: true,
isBest: true,
feeUsd: baseFeeLoadit,
feePercent: money((baseFeeLoadit / amount) * 100),
speed: "minutes to 1 hour",
notes:
"Fallback example route using Loadit's card→crypto conversion and on-chain settlement.",
},
],
summary:
"Fallback static routes because the AI router JSON could not be parsed. Try again for more detailed options.",
});
}

const routes = Array.isArray(parsed.routes) ? parsed.routes : [];
const cleanedRoutes = routes.slice(0, 6).map((r) => {
const feeUsd = Math.max(0, Number(r.feeUsd) || 0);
let feePercent = Number(r.feePercent) || 0;
if (feePercent < 0) feePercent = 0;
if (feePercent > 25) feePercent = 25;

return {
name: (r.name || "Unnamed route").toString(),
type: (r.type || "other").toString(),
isLoadit: Boolean(r.isLoadit),
isBest: Boolean(r.isBest),
feeUsd: money(feeUsd),
feePercent: money(feePercent),
speed: (r.speed || "unknown").toString(),
notes: (r.notes || "").toString(),
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
console.log("Loadit AI Tools (Fee Killer + AERO) running on port", PORT);
});
