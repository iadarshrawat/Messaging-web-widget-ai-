import { REPORT } from "../config/mongo.js";

/**
 * GET /api/report?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Both params are optional — defaults to today if omitted.
 *
 * Examples:
 *   /api/report                          → today only
 *   /api/report?from=2025-06-01          → June 1 to today
 *   /api/report?from=2025-06-01&to=2025-06-07  → June 1–7
 *   /api/report?to=2025-06-07            → today to June 7 (or just June 7 if same day)
 */
export async function generateReport(req, res) {
  try {
    // ── 1. Parse & validate query params ──────────────────────────────────
    const todayStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    const fromStr = req.query.from || todayStr;
    const toStr   = req.query.to   || todayStr;

    const fromDate = new Date(fromStr);
    const toDate   = new Date(toStr);

    if (isNaN(fromDate) || isNaN(toDate)) {
      return res.status(400).json({
        success: false,
        error: "Invalid date format. Use YYYY-MM-DD for 'from' and 'to' params.",
      });
    }

    if (fromDate > toDate) {
      return res.status(400).json({
        success: false,
        error: "'from' date cannot be after 'to' date.",
      });
    }

    // Build UTC range: start of fromDate → end of toDate
    const startOfRange = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate(), 0, 0, 0, 0));
    const endOfRange   = new Date(Date.UTC(toDate.getUTCFullYear(),   toDate.getUTCMonth(),   toDate.getUTCDate(),   23, 59, 59, 999));

    // ── 2. Query MongoDB ───────────────────────────────────────────────────
    const records = await REPORT.find({
      createdAt: { $gte: startOfRange, $lte: endOfRange },
    }).lean();

    // ── 3. Build summary ───────────────────────────────────────────────────
    const breakdown = { satisfied: 0, neutral: 0, unsatisfied: 0, escalated: 0 };
    let skipped = 0;

    for (const r of records) {
      const score = r.score;
      if (!score || score === "insufficient_data") {
        skipped++;
      } else if (breakdown[score] !== undefined) {
        breakdown[score]++;
      }
    }

    const scoredCount = records.length - skipped;
    const csatPercent = scoredCount > 0
      ? Math.round((breakdown.satisfied / scoredCount) * 100)
      : null;

    // ── 4. Shape ticket list ───────────────────────────────────────────────
    const tickets = records.map((r) => ({
      ticket_id:  r.id,
      score:      r.score ?? null,
      created_at: r.createdAt ?? null,
    }));

    return res.status(200).json({
      success:      true,
      generated_at: new Date().toISOString(),
      date_range: {
        from: fromStr,
        to:   toStr,
      },
      summary: {
        total_tickets:        records.length,
        scored_tickets:       scoredCount,
        skipped_insufficient: skipped,
        csat_percent:         csatPercent,
        score_breakdown:      breakdown,
      },
      tickets,
    });

  } catch (err) {
    console.error("generateReport error:", err);
    return res.status(500).json({
      success:      false,
      generated_at: new Date().toISOString(),
      error:        err.message,
    });
  }
}