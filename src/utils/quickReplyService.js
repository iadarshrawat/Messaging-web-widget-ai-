import Anthropic from "@anthropic-ai/sdk";
import { generateContent } from "../config/openai.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Brand → Anthropic File ID map ───────────────────────────────────────────
const BRAND_FILE_IDS = {
  "Road & Homes": "file_011Ca7NVMbGLZfJoUcBP9f7i",
  "Comfort Zone": "file_011Ca7NUZ1amijgSRPr8oyrD",
  "Mr Brand": "file_011Ca7NTQzbY33Bz2cTCBiF2",
};

/**
 * Generate contextual quick replies scoped strictly to the knowledge base.
 *
 * Rules:
 * 1. Only generate quick replies when the bot's reply actually answers the question.
 * 2. Each suggestion must be a natural follow-up the bot can answer from what was covered.
 * 3. If the bot's reply is a greeting, suggest common entry-point questions.
 * 4. Return [] when confidence is low — preferred over bad suggestions.
 * 5. Quick replies are from the USER's perspective.
 * 6. Max 3 options, each ≤ 5 words.
 *
 * @param {string} userMessage
 * @param {string} botReply
 * @param {string} brand - Brand name to fetch the correct knowledge base file
 * @returns {Promise<string[]>}
 */
export async function generateContextualQuickReplies(userMessage, botReply, brand) {
  try {
    const OUT_OF_SCOPE_SIGNAL = "I'm sorry, I'm not trained to answer";
    if (botReply.includes(OUT_OF_SCOPE_SIGNAL)) {
      console.log("⏭️ Skipping quick replies — bot reply is out-of-scope");
      return [];
    }

    const fileId = BRAND_FILE_IDS[brand] || BRAND_FILE_IDS["Mr Brand"];
    console.log(`🔍 Generating quick replies for brand: ${brand}, using file: ${fileId}`);
    console.log(`📨 User message: ${userMessage}`);
    console.log(`🤖 Bot reply: ${botReply.substring(0, 100)}...`);

    const prompt = `You are a quick-reply assistant for a customer support chatbot.

Your job is to suggest short follow-up questions a customer might click ONLY IF:
  (a) The follow-up is a natural continuation of the current topic.
  (b) The bot's reply already contains enough context that suggests it CAN answer the follow-up.
  (c) You are CONFIDENT the follow-up is within the scope of what was just answered.
  (d) MOST IMPORTANT: Check the knowledge base document provided — verify you are confident the bot CAN answer the follow-up question based ONLY on the knowledge base.

STRICT RULES:
- Return an empty array [] if you are not confident any follow-up fits.
- Never suggest topics that are unrelated to the bot's reply.
- Never suggest topics that sound like they'd require live system access (e.g. order tracking, live inventory, real-time pricing).
- Never suggest vague filler options like "Need more help" or "Other questions".
- Each reply must be from the USER's perspective, as if they are clicking it.
- Max 3 options. Each option must be 5 words or fewer.
- If the bot's reply is a greeting, suggest 2–3 common support entry points ONLY if they sound relevant to the brand topic in the reply.

Bot reply:
"""
${botReply}
"""

User's original message:
"""
${userMessage}
"""

Respond with a valid JSON array of strings only — no explanation, no markdown, no extra text.
If no good options exist, respond with exactly: []`;

    console.log(`📤 Calling Claude API for quick replies with file: ${fileId}`);
    const response = await anthropic.beta.messages.create(
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "file", file_id: fileId },
                title: `${brand} Knowledge Base`,
                context:
                  "This is the official knowledge base for this brand. Only use this document to answer customer questions.",
                cache_control: { type: "ephemeral" },
              },
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        ],
      },
      {
        headers: {
          "anthropic-beta": "files-api-2025-04-14",
        },
      }
    );

    console.log(`✅ Claude API response received for quick replies`);
    const content = response.content[0];
    if (content.type !== "text") {
      console.warn("Unexpected response type from Claude");
      return [];
    }

    console.log(`📝 Claude response for quick replies: ${content.text}`);
    const clean = content.text.replace(/```json|```/gi, "").trim();
    const parsed = JSON.parse(clean);

    if (!Array.isArray(parsed)) {
      console.warn("Quick reply response was not an array — returning []");
      return [];
    }

    const GENERIC_PHRASES = ["need more help", "other questions", "contact support", "help me"];
    const filtered = parsed
      .filter((r) => typeof r === "string" && r.trim().length > 0)
      .filter((r) => r.trim().split(" ").length <= 5)
      .filter((r) => !GENERIC_PHRASES.some((g) => r.toLowerCase().includes(g)))
      .slice(0, 3);

    console.log(`💬 Contextual quick replies generated: ${JSON.stringify(filtered)}`);
    return filtered;
  } catch (err) {
    console.error("Contextual quick reply error:", err.message);
    console.error("Error stack:", err.stack);
    return [];
  }
}
