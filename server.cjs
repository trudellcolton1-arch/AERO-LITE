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
            "- In 'notes', mention any tradeoffs, including extra off-ramp, cash-out, or withdrawal costs when relevant (e.g., stablecoins, P2P, OTC).\n\n" +
            "Return STRICT JSON ONLY with this schema:\n" +
            "{\n" +
            '  \"routes\": [\n' +
            "    {\n" +
            '      \"name\": string,\n' +
            '      \"type\": \"bank\" | \"remittance\" | \"exchange\" | \"p2p\" | \"other\",\n' +
            '      \"isLoadit\": boolean,\n' +
            '      \"isBest\": boolean,\n' +
            '      \"feeUsd\": number,\n' +
            '      \"feePercent\": number,\n' +
            '      \"speed\": string,\n' +
            '      \"notes\": string\n' +
            "    }\n" +
            "  ],\n" +
            '  \"summary\": string\n' +
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
            name: "Centralized Crypto Exchange Transfer",
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
              "Recommended route – LMS takes cash or card in on the send side, routes value over the cheapest digital asset rails (often stablecoins) behind the scenes, and converts it back into local fiat for the receiver. The sender and receiver never touch a crypto wallet. LMS exposes that as a single ~0.20% platform fee (plus a small $0.50 buffer for transfers ≤ $100) and is designed to beat Western Union, MoneyGram, and exchanges on both cost and speed, while enabling in-store cash pickup or low-fee withdrawal where supported.",
          },
        ],
        summary:
          "Fallback static routes because the AI router JSON could not be parsed. Try again for more detailed options.",
      });
    }

    const aiRoutes = Array.isArray(parsed.routes) ? parsed.routes : [];

    // --- Normalize AI routes (NON-Loadit only) ---
    let hasP2P = false;

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

      // --- Stablecoin / on-chain crypto routes (USDC/USDT/etc) ---
      const looksStable =
        lowerName.includes("stable") ||
        lowerName.includes("usdc") ||
        lowerName.includes("usdt");

      // Only treat it as a pure stablecoin rail if it's not a P2P-type route.
      if (looksStable && lowerType !== "p2p") {
        if (!speed) speed = "Minutes";

        // Rough model of typical off-ramp + withdrawal fees to get cash from stablecoins.
        let withdrawPct;
        if (amount < 500) withdrawPct = 1.5; // small transfers hit hardest
        else if (amount < 5000) withdrawPct = 1.0;
        else withdrawPct = 0.6;
        const fixedOffRamp = 5;
        const midWithdrawFeeUsd = money(
          (withdrawPct / 100) * amount + fixedOffRamp
        );
        const lowWithdrawFeeUsd = money(midWithdrawFeeUsd * 0.7);
        const highWithdrawFeeUsd = money(midWithdrawFeeUsd * 1.3);

        notes =
          `On-chain stablecoin transfer (e.g., USDC or USDT). Technically fast and can look cheap for advanced crypto users who already manage wallets, gas fees, and off-ramps. ` +
          `But to turn stablecoins back into spendable cash, most people still have to use an exchange or off-ramp and pay separate withdrawal and payout fees. ` +
          `For an amount around $${amount.toFixed(
            2
          )}, typical off-ramp + withdrawal costs just to get back to fiat usually land in the ~$${lowWithdrawFeeUsd.toFixed(
            2
          )}–$${highWithdrawFeeUsd.toFixed(
            2
          )} range, with about $${midWithdrawFeeUsd.toFixed(
            2
          )} as a reasonable mid-point. ` +
          `Compared to this DIY stablecoin flow, LMS automates the digital-asset hop and pays out directly in local fiat with a simple ~0.20% platform fee, so users never have to touch wallets or exchanges.`;
        type = "exchange"; // treat it as an on-chain/exchange-style rail
      }

      // --- P2P / OTC crypto routes ---
      const looksP2P =
        lowerType === "p2p" ||
        lowerName.includes("p2p") ||
        lowerName.includes("localbitcoins") ||
        lowerName.includes("otc");

      if (looksP2P) {
        hasP2P = true;
        if (!speed) speed = "Hours to 1 day";

        // Rough model of P2P/OTC cash-out costs to get fiat.
        let p2pPct;
        if (amount < 500) p2pPct = 3.0; // small P2P transfers get heavy spreads
        else if (amount < 5000) p2pPct = 2.0;
        else p2pPct = 1.2;
        const fixedP2P = 8; // extra hassle / desk fee
        const midP2PFeeUsd = money((p2pPct / 100) * amount + fixedP2P);
        const lowP2PFeeUsd = money(midP2PFeeUsd * 0.7);
        const highP2PFeeUsd = money(midP2PFeeUsd * 1.3);

        name = "P2P / OTC Crypto Transfer";
        notes =
          `Peer-to-peer or OTC crypto transfer. On-chain fees themselves can be low, but most receivers still need to cash out through an OTC desk, reseller, or exchange to get usable fiat. ` +
          `That usually means spreads, desk markups, and withdrawal or bank deposit fees. ` +
          `For an amount around $${amount.toFixed(
            2
          )}, real-world cash-out costs for P2P/OTC typically fall in the ~$${lowP2PFeeUsd.toFixed(
            2
          )}–$${highP2PFeeUsd.toFixed(
            2
          )} range, with about $${midP2PFeeUsd.toFixed(
            2
          )} as a reasonable mid-point. ` +
          `Bottom line: the cheap % you see on raw crypto transfers does NOT include these off-ramp/cash-out costs. If the receiver needs local cash, doing it manually via P2P/OTC usually ends up more expensive, slower, and riskier than letting LMS route and off-ramp for ~0.20% all-in.`;
        type = "p2p";

        // Use the mid-point as the modeled fee for this route
        feeUsd = midP2PFeeUsd;
        feePercent = money((feeUsd / amount) * 100);
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

    // --- Synthetic P2P / OTC rail if AI didn't give us one ---
    let p2pRoute = null;
    if (!hasP2P) {
      let p2pPct;
      if (amount < 500) p2pPct = 3.0;
      else if (amount < 5000) p2pPct = 2.0;
      else p2pPct = 1.2;
      const fixedP2P = 8;
      const midP2PFeeUsd = money((p2pPct / 100) * amount + fixedP2P);
      const lowP2PFeeUsd = money(midP2PFeeUsd * 0.7);
      const highP2PFeeUsd = money(midP2PFeeUsd * 1.3);

      p2pRoute = {
        name: "P2P / OTC Crypto Transfer",
        type: "p2p",
        isLoadit: false,
        isBest: false,
        feeUsd: midP2PFeeUsd,
        feePercent: money((midP2PFeeUsd / amount) * 100),
        speed: "Hours to 1 day",
        notes:
          `Peer-to-peer or OTC crypto transfer. On-chain fees can look cheap, but most receivers still need to cash out through an OTC desk, reseller, or exchange to get usable fiat. ` +
          `That usually means spreads, desk markups, and withdrawal or bank deposit fees. ` +
          `For an amount around $${amount.toFixed(
            2
          )}, real-world cash-out costs for P2P/OTC typically fall in the ~$${lowP2PFeeUsd.toFixed(
            2
          )}–$${highP2PFeeUsd.toFixed(
            2
          )} range, with about $${midP2PFeeUsd.toFixed(
            2
          )} as a reasonable mid-point just to get back to fiat. ` +
          `Bottom line: the cheap % you see on raw crypto transfers does NOT include these off-ramp/cash-out costs. For normal users who just want local cash, LMS's ~0.20% all-in fee is usually cheaper, simpler, and safer than DIY P2P/OTC.`,
      };
    }

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
        "Recommended route – LMS takes cash or card from the sender, routes the value over the cheapest digital asset rails (often stablecoins) under the hood, and settles back into local fiat for the receiver. The sender and receiver stay 100% in fiat: no wallets, no seed phrases, no exchanges. LMS wraps this into a single ~0.20% platform fee (plus a small $0.50 buffer for transfers ≤ $100) and is designed to beat Western Union, MoneyGram, centralized exchanges, DIY stablecoin routes, and P2P/OTC once off-ramp/withdrawal and cash-out costs are included, while enabling in-store cash pickup or low-fee withdrawals where supported.",
    };

    const extraRoutes = [wuRoute, mgRoute];
    if (p2pRoute) extraRoutes.push(p2pRoute);

    const finalRoutes = [...normalized, ...extraRoutes, lmsRoute];

    return res.json({
      routes: finalRoutes,
      summary:
        parsed.summary ||
        `AERO simulated multiple rails from ${from} to ${to}. LMS is modeled as the modern option that uses the cheapest digital-asset rails under the hood, but keeps the experience fiat-only on both sides with ~0.20% all-in platform fees (plus a small buffer on smaller transfers), and avoids the extra off-ramp/withdrawal and cash-out costs users would face with DIY stablecoin or P2P/OTC crypto routes.`,
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
