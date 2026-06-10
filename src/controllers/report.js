import https from "https";
import dotenv from "dotenv";
import { CLAUDE_CONFIG, createClaudeClient } from "../config/claude.js";
import { createZendeskClient, ZENDESK_CONFIG } from "../config/zendesk.js";

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
  // Prefer explicit baseUrl if configured, otherwise build from domain
  if (ZENDESK_CONFIG.baseUrl) {
    return `${ZENDESK_CONFIG.baseUrl}/api/v2`;
  }
  if (ZENDESK_CONFIG.domain) {
    return `https://${ZENDESK_CONFIG.domain}.zendesk.com/api/v2`;
  }
  throw new Error('Zendesk domain not configured (ZENDESK_DOMAIN / ZENDESK_BASEURL)');
}

/**
 * Fetch today's AI agent tickets
 */
async function fetchTodaysTickets() {
  // Get today's date in ISO format at midnight IST (UTC+5:30)
  const now = new Date();
  const todayIST = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  todayIST.setHours(0, 0, 0, 0);
  const createdAfter = todayIST.toISOString().replace(".000Z", "+05:30");

  const url =
    `${zendeskBase()}/tickets` +
    `?support_type_scope=ai_agent` +
    `&created_after=${encodeURIComponent(createdAfter)}` +
    `&per_page=100`;

  console.log(`\n📋 Fetching tickets created after: ${createdAfter}`);

  const res = await httpRequest(url, {
    headers: {
      Authorization: zendeskAuth(),
      "Content-Type": "application/json",
    },
  });

  if (res.status !== 200) {
    throw new Error(`Zendesk tickets API failed: ${res.status} — ${JSON.stringify(res.body)}`);
  }

  const tickets = res.body.tickets || [];
  console.log(`✅ Found ${tickets.length} AI agent tickets today`);
  return tickets;
}

/**
 * Fetch comments for a specific ticket
 */
async function fetchTicketComments(ticketId) {
  const url = `${zendeskBase()}/tickets/${ticketId}/comments`;

  const res = await httpRequest(url, {
    headers: {
      Authorization: zendeskAuth(),
      "Content-Type": "application/json",
    },
  });

  if (res.status !== 200) {
    throw new Error(`Comments API failed for ticket ${ticketId}: ${res.status}`);
  }

  console.log(res);

  return res.body.comments || [];
}

// ─── COMMENT CLEANER ─────────────────────────────────────────────────────────

/**
 * Strips all Zendesk metadata from comments.
 * Returns only the actual chat lines with a speaker label.
 *
 * A comment has:
 *   - author_id: number
 *   - body: raw text (may contain HTML or system noise)
 *   - type: "Comment" | "VoiceComment" etc
 *   - public: bool
 *   - via.channel: "native_messaging" | "web" | etc
 *
 * We discard:
 *   - System/automation messages (empty bodies, ticket-created notices)
 *   - HTML tags
 *   - Duplicate whitespace / newlines
 *   - Internal (non-public) agent notes
 */
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
    // Skip internal (private) notes — those aren't part of the customer chat
    if (!comment.public) continue;

    // Strip HTML tags
    let text = (comment.body || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();

    // Skip empty or noisy system messages
    if (!text || SYSTEM_NOISE_PATTERNS.some((p) => p.test(text))) continue;

    // Determine speaker
    // - If author is the ticket requester → Customer
    // - Otherwise → Bot (or Agent, but in ai_agent tickets it's the bot)
    const isCustomer = comment.author_id === ticketRequesterId;
    const speaker = isCustomer ? "Customer" : "Bot";

    cleaned.push({ speaker, text });
  }

  return cleaned;
}

/**
 * Format cleaned chat into a readable conversation string for Claude
 */
function formatConversation(cleanedMessages) {
  if (!cleanedMessages.length) return "(No conversation content found)";

  return cleanedMessages
    .map(({ speaker, text }) => `${speaker}: ${text}`)
    .join("\n");
}

// ─── CLAUDE SCORING ──────────────────────────────────────────────────────────

const SCORING_PROMPT = `You are a customer support quality analyst evaluating AI chatbot conversations.

Read the conversation below and return ONLY a JSON object — no explanation, no markdown, no extra text.

Scoring rules:
- "satisfied"   : Customer got a clear, correct answer. Tone is positive or neutral at the end. No repeated questions. Short, resolved ending.
- "neutral"     : Answer was given but customer seemed uncertain, asked the same thing more than once, or the ending was abrupt without confirmation.
- "unsatisfied" : Customer expressed frustration, used negative language, repeated themselves without resolution, or gave up mid-conversation.
- "escalated"   : Customer explicitly asked for a human agent, the bot said it can't help, or the conversation shows a clear failure to resolve.
- "insufficient_data" : Conversation is too short (1-2 messages only) or has no real content to judge.

Return format:
{
  "score": "satisfied" | "neutral" | "unsatisfied" | "escalated" | "insufficient_data",
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

  const res = await client.post('/messages', payload);

//   const res = await httpRequest("https://api.anthropic.com/v1/messages", {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       "x-api-key": CONFIG.anthropic.apiKey,
//       "anthropic-version": "2023-06-01",
//     },
//     body: payload,
//   });

  if (!res || res.status !== 200) {
    throw new Error(`Claude API failed: ${res?.status || 'no-response'} — ${JSON.stringify(res?.data || res)}`);
  }

  const rawText = res.data?.content?.[0]?.text || "{}";

  try {
    // Strip any accidental markdown fences
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

async function processTicket(ticket) {
  const ticketId = ticket.id;
  const requesterId = ticket.requester_id;

  try {
  // 1. Fetch raw comments
  const rawComments = await fetchTicketComments(ticketId);
  const commentsCount = Array.isArray(rawComments) ? rawComments.length : (rawComments?.comments?.length || 0);
  console.log(`  Fetched ${commentsCount} comments for ticket #${ticketId}`);

    // 2. Clean and extract only chat content
    const cleanedMessages = cleanComments(rawComments, requesterId);

    // 3. Format as readable conversation
    const conversationText = formatConversation(cleanedMessages);

    // 4. Score with Claude
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

/**
 * Summarise results into CSAT stats
 */
function summariseResults(results) {
  const scored = results.filter((r) => r.csat && r.csat.score !== "insufficient_data");
  const counts = { satisfied: 0, neutral: 0, unsatisfied: 0, escalated: 0 };

  for (const r of scored) {
    if (counts[r.csat.score] !== undefined) counts[r.csat.score]++;
  }

  const total = scored.length;
  const csatPercent = total
    ? Math.round((counts.satisfied / total) * 100)
    : null;

  return {
    total_tickets: results.length,
    scored_tickets: total,
    skipped_insufficient: results.length - total,
    score_breakdown: counts,
    csat_percent: csatPercent,
    errors: results.filter((r) => r.status === "error").length,
  };
}

export async function runReport() {
  console.log("🚀 Zendesk AI Bot CSAT Scoring Pipeline\n");

  // Validate config
  if (!ZENDESK_CONFIG.email || !ZENDESK_CONFIG.apiToken) {
    console.error("❌ Missing ZENDESK_EMAIL or ZENDESK_API_TOKEN env vars");
    return { success: false, error: "Missing Zendesk credentials" };
  }
  if (!CLAUDE_CONFIG.apiKey) {
    console.error("❌ Missing ANTHROPIC_API_KEY env var");
    return { success: false, error: "Missing Claude credentials" };
  }

  try {
    // Step 1: Get today's tickets
    const tickets = await fetchTodaysTickets();
    console.log(`fetchtodaysticket`, tickets);
    if (!tickets.length) {
      console.log("ℹ️  No AI agent tickets found for today.");
      return { success: true, message: "No tickets found", summary: null };
    }

    // Step 2: Process each ticket (sequential to avoid rate limits)
    console.log(`\n🔄 Processing ${tickets.length} tickets...\n`);
    const results = [];

    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      process.stdout.write(`  [${i + 1}/${tickets.length}] Ticket #${ticket.id} ... `);

      const result = await processTicket(ticket);
      results.push(result);

      if (result.status === "scored") {
        const score = result.csat.score;
        const emoji =
          score === "satisfied" ? "✅" :
          score === "neutral" ? "🟡" :
          score === "unsatisfied" ? "❌" :
          score === "escalated" ? "🔺" : "⚪";
        console.log(`${emoji} ${score} (${result.csat.confidence} confidence)`);
      } else {
        console.log(`⚠️  ${result.error}`);
      }

      // Small delay to be polite to APIs
      if (i < tickets.length - 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    // Step 3: Summarise
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

    // Step 4: Print full JSON results (pipe to file if needed)
    console.log("\n📄 Full Results (JSON):\n");
    console.log(JSON.stringify({ summary, results }, null, 2));

    return { success: true, summary, results };
  } catch (err) {
    console.error("\n❌ Fatal error:", err.message);
    return { success: false, error: err.message };
  }
}