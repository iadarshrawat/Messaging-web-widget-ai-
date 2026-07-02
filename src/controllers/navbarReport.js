import { createZendeskClient } from "../config/zendesk.js";

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

    // ── 2. Query Zendesk custom object (ticket_csat_scores) ────────────────
    const zendeskClient = createZendeskClient();
    const objectKey = "ticket_csat_scores";

    // Build filter payload for Zendesk custom object search.
    // Note: some Zendesk instances do not support range operators ($gte/$lte)
    // on text custom fields. We use equality for single-day queries on the
    // `report_date` custom field, and for multi-day ranges we filter by the
    // record's `created_at` timestamp (ISO range) which the API accepts.
    let filter = {};
    if (fromStr === toStr) {
      // Exact date — use the custom field (string YYYY-MM-DD)
      filter = { "custom_object_fields.report_date": { "$eq": fromStr } };
    } else {
      // Date range — filter by record created_at (ISO timestamps)
      const fromIso = `${fromStr}T00:00:00Z`;
      const toIso = `${toStr}T23:59:59Z`;
      filter = {
        "$and": [
          { "created_at": { "$gte": fromIso } },
          { "created_at": { "$lte": toIso } },
        ],
      };
    }

    const searchPayload = {
      filter,
      sort: "-created_at",
    };

    let searchRes;
    try {
      searchRes = await zendeskClient.post(
        `/custom_objects/${objectKey}/records/search`,
        searchPayload
      );
    } catch (err) {
      console.error("Zendesk filtered search error:", err.response?.data || err.message);
      const msg = err.response?.data?.error?.message || err.response?.data || err.message;
      return res.status(502).json({ success: false, error: `Zendesk filtered search failed: ${msg}` });
    }

    const records = searchRes.data?.custom_object_records || searchRes.data?.results || [];

    // ── 3. Build summary ───────────────────────────────────────────────────
    const breakdown = { satisfied: 0, neutral: 0, unsatisfied: 0, escalated: 0 };
    let skipped = 0;

    for (const r of records) {
      // Zendesk custom object record shape: { custom_object_fields: { ticket_id, csat_score, ... } }
      const fields = r.custom_object_fields || {};
      const score = fields.csat_score;
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
    const tickets = records.map((r) => {
      const fields = r.custom_object_fields || {};
      return {
        ticket_id:  fields.ticket_id || null,
        score:      fields.csat_score || null,
        created_at: fields.ticket_created_at || r.created_at || null,
      };
    });

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