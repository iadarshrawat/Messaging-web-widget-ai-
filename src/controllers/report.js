import https from "https";
import dotenv from "dotenv";
import { CLAUDE_CONFIG, createClaudeClient } from "../config/claude.js";
import { createZendeskClient, ZENDESK_CONFIG } from "../config/zendesk.js";
import { REPORT } from "../config/mongo.js";

dotenv.config();

// ─── HTTP HELPER ─────────────────────────────────────────────────────────────

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── ZENDESK API ─────────────────────────────────────────────────────────────

function zendeskAuth() {
  const creds = `${ZENDESK_CONFIG.email}/token:${ZENDESK_CONFIG.apiToken}`;
  return "Basic " + Buffer.from(creds).toString("base64");
}

function zendeskBase() {
  if (ZENDESK_CONFIG.baseUrl) {
    return `${ZENDESK_CONFIG.baseUrl}/api/v2`;
  }
  if (ZENDESK_CONFIG.domain) {
    return `https://${ZENDESK_CONFIG.domain}.zendesk.com/api/v2`;
  }
  throw new Error("Zendesk domain not configured (ZENDESK_DOMAIN / ZENDESK_BASEURL)");
}

async function fetchTodaysTickets() {
  const now = new Date();
  const todayEST = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));

  const yesterdayEST = new Date(todayEST);
  yesterdayEST.setDate(yesterdayEST.getDate() - 1);

  const tomorrowEST = new Date(todayEST);
  tomorrowEST.setDate(tomorrowEST.getDate() + 1);

  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  return await fetchTicketsByDateRange(fmt(yesterdayEST), fmt(tomorrowEST));
}

// Fetch tickets for a given date range and include escalated tickets.
// We run two searches in parallel: AI agent tickets and escalated tickets, then dedupe.
async function fetchTicketsByDateRange(startDate, endDate) {
  const queryAgent = `type:ticket support_type:ai_agent created>${startDate} created<${endDate}`;
  const queryEscal = `type:ticket tags:escalated_to_agent created>${startDate} created<${endDate}`;

  const urlAgent = `${zendeskBase()}/search?query=${encodeURIComponent(queryAgent)}&per_page=100`;
  const urlEscal = `${zendeskBase()}/search?query=${encodeURIComponent(queryEscal)}&per_page=100`;

  console.log(`\n📋 Fetching tickets with queries:`);
  console.log(`   • ${queryAgent}`);
  console.log(`   • ${queryEscal}`);

  const [resAgent, resEscal] = await Promise.all([
    httpRequest(urlAgent, { headers: { Authorization: zendeskAuth(), "Content-Type": "application/json" } }),
    httpRequest(urlEscal, { headers: { Authorization: zendeskAuth(), "Content-Type": "application/json" } }),
  ]);

  if (resAgent.status !== 200) {
    throw new Error(`Zendesk search API failed (agent): ${resAgent.status}`);
  }
  if (resEscal.status !== 200) {
    throw new Error(`Zendesk search API failed (escalated): ${resEscal.status}`);
  }

  const listAgent = resAgent.body.results || [];
  const listEscal = resEscal.body.results || [];

  // Merge and dedupe by ticket id
  const map = new Map();
  for (const t of listAgent) map.set(t.id, t);
  for (const t of listEscal) map.set(t.id, { ...(map.get(t.id) || {}), ...t });

  const tickets = Array.from(map.values());
  console.log(`✅ Found ${tickets.length} tickets (including escalated)`);
  return tickets;
}

// Process tickets in batches using Promise.all for concurrency control
async function processTicketsInBatches(tickets, batchSize = 6) {
  const results = [];
  for (let i = 0; i < tickets.length; i += batchSize) {
    const batch = tickets.slice(i, i + batchSize);
    const promises = batch.map(async (ticket) => {
      // mark escalated flag on ticket for downstream use
      const isEsc = Array.isArray(ticket.tags) && ticket.tags.includes("escalated_to_agent");
      ticket.is_escalated = isEsc;

      if (isEsc) {
        // Short-circuit: if the ticket was escalated to agent, we don't need LLM scoring.
        // Create a lightweight escalated result and skip processTicket() to save API calls.
        return {
          ticket_id: ticket.id,
          subject: ticket.subject,
          created_at: ticket.created_at,
          requester_id: ticket.requester_id,
          message_count: 0,
          conversation_preview: "(escalated to agent)",
          csat: {
            score: "escalated",
            confidence: "high",
            reason: "Ticket was escalated to an agent; skipped automated scoring",
            key_issue: null,
          },
          status: "scored",
          is_escalated: true,
        };
      }

      const res = await processTicket(ticket);
      // propagate escalated flag into result
      res.is_escalated = false;
      return res;
    });

    const settled = await Promise.all(promises);
    results.push(...settled);

    // small delay between batches to reduce rate-limit pressure
    if (i + batchSize < tickets.length) await new Promise((r) => setTimeout(r, 300));
  }
  return results;
}

async function fetchTicketComments(ticketId) {
  // Use the conversation_log endpoint which contains system comments and
  // conversation messages produced by Sunshine (messaging events).
  const url = `${zendeskBase()}/tickets/${ticketId}/conversation_log`;

  const res = await httpRequest(url, {
    headers: {
      Authorization: zendeskAuth(),
      "Content-Type": "application/json",
    },
  });

  if (res.status !== 200) {
    throw new Error(`Conversation log API failed for ticket ${ticketId}: ${res.status}`);
  }

  // The conversation_log returns an object with `events` (array).
  const events = res.body.events || res.body || [];

  // Normalize events to the previous comments shape so cleanComments() can work
  return (Array.isArray(events) ? events : []).map((ev) => {
    // Extract message text from common places
    let body = "";
    if (ev.content) {
      if (typeof ev.content.text === "string") body = ev.content.text;
      else if (typeof ev.content.body === "string") body = ev.content.body;
      else if (ev.content.type === "html" && ev.content.body) body = ev.content.body;
    }

    // Author id: prefer zendesk support user id (numeric) then sunshine user id
    const author = ev.author || {};
    const authorSupportId = author["zen:support:user_id"] ?? author.zen?.support?.user_id ?? author.user_id;
    const authorSuncoId = author["zen:sunco:user_id"] ?? author.zen?.sunco?.user_id ?? null;

    // Conversation events sometimes include metadata.is_public (false for system ticket comment)
    // Treat undefined as public (so messaging events are considered), but respect explicit false
    const isPublic = ev.metadata?.is_public === false ? false : true;

    return {
      id: ev.id,
      type: ev.type,
      body: body || "",
      author_id: authorSupportId ?? authorSuncoId ?? null,
      // keep raw author object in case callers want richer info
      author_raw: author,
      public: isPublic,
      created_at: ev.created_at || ev.received_at,
      raw: ev,
    };
  });
}

// ─── COMMENT CLEANER ─────────────────────────────────────────────────────────

function cleanComments(rawComments, ticketRequesterId) {
  const SYSTEM_NOISE_PATTERNS = [
    /^conversation with web user/i,
    /^this is an automated/i,
    /^ticket #\d+/i,
    /^\s*$/,
    /^--$/,
    /notification/i,
  ];

  const cleaned = [];

  for (const comment of rawComments) {
    if (!comment.public) continue;

    let text = (comment.body || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();

    if (!text || SYSTEM_NOISE_PATTERNS.some((p) => p.test(text))) continue;

    const isCustomer = comment.author_id === ticketRequesterId;
    const speaker = isCustomer ? "Customer" : "Bot";

    cleaned.push({ speaker, text });
  }

  return cleaned;
}

function formatConversation(cleanedMessages) {
  if (!cleanedMessages.length) return "(No conversation content found)";
  return cleanedMessages.map(({ speaker, text }) => `${speaker}: ${text}`).join("\n");
}

// ─── CLAUDE SCORING ──────────────────────────────────────────────────────────

const SCORING_PROMPT = `You are a customer support quality analyst evaluating AI chatbot conversations.

Read the conversation below and return ONLY a JSON object — no explanation, no markdown, no extra text.

Scoring rules:
- "satisfied"   : if customer asked a question related to the brand and the bot successfully answered it in a helpful way.

- "unsatisfied" : Customer expressed frustration, used negative language, repeated themselves without resolution, or the bot gave out-of-context or irrelevant answers.

- "neutral"     : Customer only greeted or asked a brief brand-related query (e.g. "hello", "hi", "what is your brand?"), or the interaction is informational/ambiguous and does not demonstrate clear satisfaction or dissatisfaction. Greeting + a simple brand question should be marked neutral, not satisfied.

Return format:
{
  "score": "satisfied" | "unsatisfied",
  "confidence": "high" | "medium" | "low",
  "reason": "One concise sentence explaining the score",
  "key_issue": "The main topic or problem the customer asked about (null if unclear)"
}

Conversation:
`;

async function scoreConversationWithClaude(conversationText) {
  const client = createClaudeClient();

  const payload = JSON.stringify({
    model: CLAUDE_CONFIG.model,
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: SCORING_PROMPT + conversationText,
      },
    ],
  });

  const res = await client.post("/messages", payload);

  if (!res || res.status !== 200) {
    throw new Error(
      `Claude API failed: ${res?.status || "no-response"} — ${JSON.stringify(res?.data || res)}`
    );
  }

  const rawText = res.data?.content?.[0]?.text || "{}";

  try {
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return {
      score: "insufficient_data",
      confidence: "low",
      reason: "Claude returned unparseable response",
      key_issue: null,
      raw: rawText,
    };
  }
}

// ─── MAIN PIPELINE ───────────────────────────────────────────────────────────
// ─── REPLACE processTicket in report.js with this ────────────────────────────

async function processTicket(ticket) {
  const ticketId = ticket.id;
  const requesterId = ticket.requester_id;

  try {
    // Use the existing fetchTicketComments + cleanComments
    const rawComments = await fetchTicketComments(ticketId);
    const cleanedMessages = cleanComments(rawComments, requesterId);

    console.log(`  💬 ${cleanedMessages.length} usable messages for ticket #${ticketId}`);

    if (cleanedMessages.length === 0) {
      return {
        ticket_id: ticketId,
        subject: ticket.subject,
        created_at: ticket.created_at,
        requester_id: requesterId,
        message_count: 0,
        conversation_preview: "(No conversation content found)",
        csat: {
          score: "insufficient_data",
          confidence: "low",
          reason: "No readable messages found in ticket",
          key_issue: null,
        },
        status: "scored",
      };
    }

    const conversationText = formatConversation(cleanedMessages);
    const claudeScore = await scoreConversationWithClaude(conversationText);

    return {
      ticket_id: ticketId,
      subject: ticket.subject,
      created_at: ticket.created_at,
      requester_id: requesterId,
      message_count: cleanedMessages.length,
      conversation_preview: conversationText.slice(0, 200) + (conversationText.length > 200 ? "..." : ""),
      csat: claudeScore,
      status: "scored",
    };

  } catch (err) {
    return {
      ticket_id: ticketId,
      subject: ticket.subject,
      created_at: ticket.created_at,
      requester_id: requesterId,
      csat: null,
      status: "error",
      error: err.message,
    };
  }
}

// ─── ALSO UPDATE summariseResults to handle insufficient_data properly ────────
function summariseResults(results) {
  const scored = results.filter(
    (r) => r.csat && r.csat.score !== "insufficient_data" && r.status !== "error"
  );
  const counts = { satisfied: 0, neutral: 0, unsatisfied: 0, escalated: 0 };

  for (const r of scored) {
    if (counts[r.csat.score] !== undefined) counts[r.csat.score]++;
  }

  const total = scored.length;
  const csatPercent = total ? Math.round((counts.satisfied / total) * 100) : null;

  return {
    total_tickets: results.length,
    scored_tickets: total,
    skipped_insufficient: results.filter((r) => r.csat?.score === "insufficient_data").length,
    score_breakdown: counts,
    csat_percent: csatPercent,
    errors: results.filter((r) => r.status === "error").length,
  };
}

// ─── ZENDESK CUSTOM OBJECT STORAGE ───────────────────────────────────────────

/**
 * Idempotent — safe to call on every run.
 * Creates the custom object type + all required fields if they don't exist yet.
 * Silently skips fields that already exist (422).
 */
async function ensureCSATCustomObject() {
  const zendeskClient = createZendeskClient();
  const objectKey = "ticket_csat_scores";

  console.log(`\n🔧 Checking custom object '${objectKey}'...`);

  // ── 1. Create object type if missing ──────────────────────────────────────
  try {
    await zendeskClient.get(`/custom_objects/${objectKey}`);
    console.log(`   ✅ Object type already exists`);
  } catch (err) {
    if (err.response?.status !== 404) throw err;

    console.log(`   📝 Creating object type...`);
    await zendeskClient.post("/custom_objects", {
      custom_object: {
        key: objectKey,
        title: "Ticket CSAT Scores",
        title_pluralized: "Ticket CSAT Scores",
        raw_title: "Ticket CSAT Scores",
        raw_title_pluralized: "Ticket CSAT Scores",
        description: "AI chatbot CSAT scores per ticket",
        raw_description: "AI chatbot CSAT scores per ticket",
      },
    });
    console.log(`   ✅ Object type created`);
  }

  // ── 2. Ensure every field exists ──────────────────────────────────────────
  const fields = [
    { key: "ticket_id",         type: "text", title: "Ticket ID" },
    { key: "ticket_subject",    type: "text", title: "Ticket Subject" },
    { key: "ticket_created_at", type: "text", title: "Ticket Created At" },
    { key: "report_date",       type: "text", title: "Report Date" },
    { key: "csat_score",        type: "text", title: "CSAT Score" },
    { key: "reason",            type: "text", title: "Scoring Reason" },
  ];

  console.log(`   🔧 Syncing ${fields.length} custom fields...`);

  for (const f of fields) {
    try {
      await zendeskClient.post(`/custom_objects/${objectKey}/fields`, {
        custom_object_field: {
          key: f.key,
          type: f.type,
          title: f.title,
          raw_title: f.title,
        },
      });
      console.log(`      ✅ Created field: ${f.key}`);
    } catch (fieldErr) {
      if (fieldErr.response?.status === 422) {
        // Already exists — perfectly fine, continue
      } else {
        console.warn(
          `      ⚠️  Could not create '${f.key}':`,
          fieldErr.response?.data?.error ?? fieldErr.message
        );
      }
    }
  }

  console.log(`✅ Custom object ready\n`);
  return true;
}

// function for storing a single ticket's CSAT result to custom object (for historical tracking)
const saveTicketCSATRecord = async (result) => {
  try {
    const zendeskClient = createZendeskClient();
    const objectKey = "ticket_csat_scores";

    const ticketId = result.ticket_id || "N/A";
    const score = result.csat?.score || "insufficient_data";
    const reason = result.csat?.reason || "";

    const today = new Date().toISOString().split("T")[0];
    const recordName = `Ticket #${ticketId} | ${today}`;

    // Step 1: Create the record with just the name
    const recordPayload = {
      custom_object_record: {
        name: recordName,
      },
    };

    const createResponse = await zendeskClient.post(
      `/custom_objects/${objectKey}/records`,
      recordPayload
    );

    const recordId = createResponse.data.custom_object_record?.id;
    if (!recordId) throw new Error("Failed to create custom object record");

    // Step 2: Update the record with custom field values
    const updatePayload = {
      custom_object_record: {
        custom_object_fields: {
          ticket_id: ticketId,
          ticket_subject: result.subject || "",
          ticket_created_at: result.created_at || "",
          report_date: today,
          csat_score: score,
          reason: reason,
        },
      },
    };

    const updateResponse = await zendeskClient.patch(
      `/custom_objects/${objectKey}/records/${recordId}`,
      updatePayload
    );

    return updateResponse.data.custom_object_record;
  } catch (err) {
    console.warn(`⚠️ Could not create CSAT record:`, err.message);
    return null;
  }
};


// ─── MAIN ENTRY POINT ────────────────────────────────────────────────────────

export async function runReport() {
  console.log("🚀 Zendesk AI Bot CSAT Scoring Pipeline\n");

  // ── Validate config ────────────────────────────────────────────────────────
  if (!ZENDESK_CONFIG.email || !ZENDESK_CONFIG.apiToken) {
    console.error("❌ Missing ZENDESK_EMAIL or ZENDESK_API_TOKEN env vars");
    return { success: false, error: "Missing Zendesk credentials" };
  }
  if (!CLAUDE_CONFIG.apiKey) {
    console.error("❌ Missing ANTHROPIC_API_KEY env var");
    return { success: false, error: "Missing Claude credentials" };
  }

  try {
    // ── Step 1: Ensure Zendesk custom object + fields exist (idempotent) ────
    await ensureCSATCustomObject();

    // ── Step 2: Fetch today's tickets ────────────────────────────────────────
    const tickets = await fetchTodaysTickets();

    if (!tickets.length) {
      console.log("ℹ️  No AI agent tickets found for today.");
      return { success: true, message: "No tickets found", summary: null };
    }

    // ── Step 3: Score each ticket with Claude (batched concurrent) ─────────
    console.log(`\n🔄 Processing ${tickets.length} tickets (batched)...\n`);
    const results = await processTicketsInBatches(tickets, 6);

    // Persist to MongoDB and log per-result
    const storageStats = { saved: 0, failed: 0 };

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      process.stdout.write(`  [${i + 1}/${results.length}] Ticket #${result.ticket_id} ... `);

      if (result.csat?.score) {
        // Store in MongoDB and Zendesk custom object (safe-wrapped)
        try {
          await REPORT.create({ id: result.ticket_id, score: result.csat.score });
          await saveTicketCSATRecord(result);
          storageStats.saved++;
          console.log(`Saved to MongoDB/Zendesk: ${result.ticket_id}`);
        } catch (storeErr) {
          storageStats.failed++;
          console.warn(`⚠️ Failed to store CSAT for ticket ${result.ticket_id}:`, storeErr?.message || storeErr);
        }
      }

      if (result.status === "scored") {
        const score = result.csat.score;
        const emoji =
          score === "satisfied"   ? "✅" :
          score === "neutral"     ? "🟡" :
          score === "unsatisfied" ? "❌" :
          score === "escalated"   ? "🔺" : "⚪";
        const escalatedMark = result.is_escalated ? " (escalated)" : "";
        console.log(`${emoji} ${score} (${result.csat.confidence} confidence)${escalatedMark}`);
      } else {
        console.log(`⚠️  ${result.error}`);
      }
    }

    // ── Step 4: Summarise ─────────────────────────────────────────────────────
    const summary = summariseResults(results);

    console.log("\n" + "═".repeat(50));
    console.log("📊 CSAT SUMMARY FOR TODAY");
    console.log("═".repeat(50));
    console.log(`Total tickets processed : ${summary.total_tickets}`);
    console.log(`Scoreable conversations : ${summary.scored_tickets}`);
    console.log(`Skipped (too short)     : ${summary.skipped_insufficient}`);
    console.log(`Errors                  : ${summary.errors}`);
    console.log("");
    console.log(`✅ Satisfied   : ${summary.score_breakdown.satisfied}`);
    console.log(`🟡 Neutral     : ${summary.score_breakdown.neutral}`);
    console.log(`❌ Unsatisfied : ${summary.score_breakdown.unsatisfied}`);
    console.log(`🔺 Escalated   : ${summary.score_breakdown.escalated}`);
    if (summary.csat_percent !== null) {
      console.log(`\n🎯 CSAT Score  : ${summary.csat_percent}%`);
    }
    console.log("═".repeat(50));

    console.log(`\n📦 Zendesk storage — saved: ${storageStats.saved}, failed: ${storageStats.failed}`);

    // ── Step 6: Full JSON output (pipe to file if needed) ────────────────────
    console.log("\n📄 Full Results (JSON):\n");
    console.log(JSON.stringify({ summary, storage: storageStats, results }, null, 2));

    return { success: true, summary, storage: storageStats, results };

  } catch (err) {
    console.error("\n❌ Fatal error:", err.message);
    return { success: false, error: err.message };
  }
}