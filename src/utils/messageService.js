import Anthropic from "@anthropic-ai/sdk";
import { createSunshineClient } from "../config/sunshine.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Brand → Anthropic File ID map ───────────────────────────────────────────
const BRAND_FILE_IDS = {
  "Road & Homes": "file_011Ca7NVMbGLZfJoUcBP9f7i",
  "Comfort Zone": "file_011Ca7NUZ1amijgSRPr8oyrD",
  "Mr Brand": "file_011Ca7NTQzbY33Bz2cTCBiF2",
};

/**
 * Get brand name from brand ID
 * @param {string} brandId - The brand ID from the conversation
 * @returns {string} - Brand name
 */
export function getBrandFromWidgetId(brandId) {
  console.log(`Determining brand from widget ID: ${brandId}`);

  if (!brandId) return "Mr Brand";

  const widgetIdMap = {
    [process.env.WIDGET_ID_ROAD_HOMES]: "Road & Homes",
    [process.env.WIDGET_ID_COMFORT_ZONE]: "Comfort Zone",
    [process.env.WIDGET_ID_MR_BRAND]: "Mr Brand",
  };
  return widgetIdMap[brandId] || "Mr Brand";
}

/**
 * Get brand-specific system prompt with knowledge base
 * @param {string} brand
 * @param {string} history
 * @returns {string}
 */
function getBrandSystemPrompt(brand, history) {
  const commonRules = `
## KNOWLEDGE BASE RULE (MOST IMPORTANT)
- You MUST only answer from the Knowledge Base document provided to you.
- If the answer is NOT in the Knowledge Base or Conversation History → respond EXACTLY:
  "I'm sorry, I'm not trained to answer questions outside of my support area.
   For further help, please type 'connect me to an agent' and a human will assist you."
- Do NOT guess, assume, or make up any answer.
- Do NOT use your general knowledge to fill gaps.

## HOW TO RESPOND
1. Be helpful and concise
2. Acknowledge the customer's concern
3. Provide clear guidance or next steps
4. End with: "Is there anything else I can help you with?"

## TONE
- Warm, professional, and concise
- Never promise outcomes you cannot guarantee
- Never repeat yourself across messages
- Use bullet points or numbered steps when helpful

---

Conversation History:
${history || "(No previous messages)"}

---`;

  if (brand === "Road & Homes") {
    return `
You are a customer support assistant for Road & Homes - a premier real estate and property management company.

## YOUR IDENTITY
You are a support BOT specializing in real estate inquiries, property listings, and home services.
You only answer based on the Knowledge Base document and Conversation History provided.
You do NOT have access to any live systems, property databases, or real-time MLS data.

## GREETING RULE
If the customer is greeting you (e.g. "hi", "hello", "hey", "good morning") —
respond warmly and ask how you can help. Example:
"Hello! 👋 Welcome to Road & Homes support. How can I help you with your property inquiry today?"

${commonRules}

REMEMBER: Always provide professional real estate guidance and be helpful with property-related questions.
`.trim();
  }

  if (brand === "Comfort Zone") {
    return `
You are a customer support assistant for Comfort Zone - a comfort and lifestyle products company.

## YOUR IDENTITY
You are a support BOT specializing in comfort products, customer care, and lifestyle inquiries.
You only answer based on the Knowledge Base document and Conversation History provided.
You do NOT have access to live inventory, shipping systems, or real-time order data.

## GREETING RULE
If the customer is greeting you (e.g. "hi", "hello", "hey", "good morning") —
respond warmly and ask how you can help. Example:
"Hello! 👋 Welcome to Comfort Zone support. How can I help you find the perfect comfort solution today?"

${commonRules}

REMEMBER: Always prioritize customer comfort and satisfaction in your responses.
`.trim();
  }

  return `
You are a customer support assistant for Mr Brand.

## YOUR IDENTITY
You are a support BOT. You only answer based on the Knowledge Base document and Conversation History provided.
You do NOT have access to any live systems, orders, accounts, or real-time data.

## GREETING RULE
If the customer is greeting you (e.g. "hi", "hello", "hey", "good morning", "howdy") —
respond warmly and ask how you can help. Example:
"Hello! 👋 Welcome to Mr Brand support. How can I help you today?"

${commonRules}

REMEMBER: Always be helpful and provide clear guidance to the customer.
`.trim();
}

/**
 * Generate bot reply using Claude with Files API
 * @param {string} brand
 * @param {string} history
 * @param {string} messageBody
 * @returns {Promise<string>}
 */
export async function generateReplyWithClaude(brand, history, messageBody) {
  const fileId = BRAND_FILE_IDS[brand] || BRAND_FILE_IDS["Mr Brand"];
  console.log(`Determined brand: ${brand}, using file ID: ${fileId}`);

  const systemPrompt = getBrandSystemPrompt(brand, history);

  console.log(`🤖 Generating Claude reply for brand: ${brand}, file: ${fileId}`);

  const response = await anthropic.beta.messages.create(
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
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
            { type: "text", text: messageBody },
          ],
        },
      ],
    },
    { headers: { "anthropic-beta": "files-api-2025-04-14" } },
  );

  const reply = response.content?.[0]?.text;
  if (!reply) throw new Error("Empty response from Claude");

  console.log(`✅ Claude reply generated (${reply.length} chars)`);
  return reply;
}

/**
 * Send a message to Sunshine conversation
 * @param {string} conversationId
 * @param {string|object} message
 * @returns {Promise<object>}
 */
export async function sendSunshineMessage(conversationId, message) {
  try {
    if (!process.env.SUNSHINE_APP_ID) {
      throw new Error("SUNSHINE_APP_ID not configured in .env");
    }

    const sunshineClient = createSunshineClient();
    const text = typeof message === "string" ? message : message.text;
    const quickReplies =
      typeof message === "object" ? message.quickReplies : null;

    const payload = {
      author: { type: "business" },
      content: {
        type: "text",
        text,
        ...(quickReplies &&
          quickReplies.length > 0 && {
            actions: quickReplies.map((q) => ({
              type: "reply",
              text: q,
              payload: q.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
            })),
          }),
      },
    };

    const response = await sunshineClient.post(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`,
      payload,
    );

    return response.data;
  } catch (err) {
    console.error(
      "Failed to send Sunshine message:",
      err.response?.data || err.message,
    );
    throw err;
  }
}

/**
 * Get conversation history for context
 * @param {string} conversationId
 * @returns {Promise<string>}
 */
export async function getConversationHistory(conversationId) {
  try {
    const client = createSunshineClient();
    const res = await client.get(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages?limit=10`,
    );

    return res.data.messages
      .slice(-6)
      .map((m) => {
        const role = m.author?.type === "business" ? "Bot" : "User";
        return `${role}: ${m.content?.text}`;
      })
      .join("\n");
  } catch (err) {
    console.error("History fetch failed:", err.message);
    return "";
  }
}