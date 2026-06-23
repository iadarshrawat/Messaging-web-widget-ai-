import axios from "axios";
import { createSunshineClient } from "../config/sunshine.js";

/**
 * Send a plain or quick-reply message to a Sunshine conversation.
 *
 * @param {string} conversationId
 * @param {string|{text: string, quickReplies?: string[]}} message
 */
async function sendSunshineMessage(conversationId, message) {
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
        markdownText:text,
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
 * Send the detail-collection form to the customer so we can gather their info
 * before escalating to a human agent.
 *
 * @param {string} conversationId
 */
export async function sendDetailCollectionForm(conversationId) {
  try {
    if (
      !process.env.SUNSHINE_APP_ID ||
      !process.env.ZENDESK_DOMAIN ||
      !process.env.SUNSHINE_KEY_ID ||
      !process.env.SUNSHINE_KEY_SECRET
    ) {
      throw new Error("Missing required config");
    }

    const payload = {
      author: { type: "business" },
      content: {
        type: "form",
        text: "Please fill out this form to help us assist you better.",
        fields: [
          {
            type: "text",
            name: "name",
            label: "Your Name",
            placeholder: "Enter your full name...",
            required: true,
          },
          {
            type: "email",
            name: "email",
            label: "Email Address",
            placeholder: "Enter your email...",
            required: true,
          },
          {
            type: "select",
            name: "category",
            label: "Issue Category",
            placeholder: "Choose the category of your issue...",
            required: true,
            options: [
              { name: "billing",   label: "Billing & Payments" },
              { name: "technical", label: "Technical Support" },
              { name: "account",   label: "Account & Profile" },
              { name: "general",   label: "General Inquiry" },
              { name: "other",     label: "Other" },
            ],
          },
          {
            type: "text",
            name: "description",
            label: "Describe Your Issue",
            placeholder: "Please describe the issue in detail...",
            required: true,
          },
        ],
      },
    };

    const endpoint = `/sc/v2/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/messages`;
    const fullURL = `https://${process.env.ZENDESK_DOMAIN}.zendesk.com${endpoint}`;
    const auth = Buffer.from(
      `${process.env.SUNSHINE_KEY_ID}:${process.env.SUNSHINE_KEY_SECRET}`,
    ).toString("base64");

    const response = await axios.post(fullURL, payload, {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
    });

    return response.data;
  } catch (err) {
    console.error(
      "Failed to send detail collection form:",
      err.response?.data || err.message,
    );
    throw err;
  }
}

/**
 * Full escalation flow:
 *  1. Send confirmation message to the customer.
 *  2. Pass switchboard control to the Zendesk agent workspace.
 *     (Zendesk handles identity resolution and user linking internally via passControl.)
 *
 * @param {string} conversationId
 * @returns {Promise<object>} - Zendesk passControl response
 */
export async function escalateToAgent(conversationId, formData = {}) {
  try {
    if (!process.env.SUNSHINE_APP_ID) {
      throw new Error("SUNSHINE_APP_ID not configured in .env");
    }

    // ── Step 1: Confirmation message to customer ──────────────────────────────
    await sendSunshineMessage(
      conversationId,
      "Perfect! Connecting you to a human agent. They'll be with you shortly. One moment... 👋",
    );

    // ── Step 2: Pass switchboard control to agent workspace ───────────────────
    // passControl handles Smooch↔Zendesk user linking and ticket association automatically.
    console.log("🔄 Passing control to agent workspace...");
    const sunshineClient = createSunshineClient();

    const metadata = { reason: "user_requested_agent" };
    metadata["dataCapture.systemField.tags"] = "tag1,tag2,escalated_to_agent";
    metadata["dataCapture.systemField.groupId"] = process.env.ZENDESK_SUPPORT_GROUP_ID;
    // Email will be set by explicit ticket update in eventHandlers.js, but include here for reference
    metadata["dataCapture.systemField.requester.email"] = formData.email || "";
    metadata["dataCapture.systemField.requester.name"] = formData.name || "";
    console.log("Passing metadata with escalation:", metadata);
    const response = await sunshineClient.post(
      `/apps/${process.env.SUNSHINE_APP_ID}/conversations/${conversationId}/passControl`,
      {
        switchboardIntegration: "zd-agentWorkspace",
        metadata,
      },
    );

    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(
      `❌ Escalation error (status=${status}):`,
      JSON.stringify(body),
    );
    throw err;
  }
}

/**
 * Detect whether a customer message is requesting ticket creation / agent escalation.
 * Uses fast keyword matching first, then falls back to an AI classifier.
 *
 * @param {string} messageBody
 * @param {Function} generateContent - AI content-generation helper
 * @returns {Promise<boolean>}
 */
export async function shouldCreateTicket(messageBody, generateContent) {
  try {
    const messageLower = messageBody.toLowerCase().trim();

    // --- 1. Informational query guard (short-circuit before any keyword/AI check) ---
    const infoPatterns = [
      /^(what|how|when|where|why|who|is|are|does|do|can|could|would|will)\b/i,
      /\b(coverage|policy|policies|pricing|price|cost|fee|fees|international|domestic|eligible|eligib|available|availability|feature|plan|plans|option|options|limit|limits|refund|return|warranty|guarantee)\b/i,
    ];

    const looksLikeInfoQuery = infoPatterns.some((pattern) =>
      pattern.test(messageLower)
    );

    // --- 2. Explicit ticket/escalation keyword match ---
    const ticketKeywords = [
      "create ticket",
      "create a ticket",
      "create an issue",
      "file a ticket",
      "file a complaint",
      "file a claim",
      "speak with agent",
      "speak with an agent",
      "speak to agent",
      "talk to agent",
      "talk to an agent",
      "connect to agent",
      "connect to an agent",
      "connect me to agent",
      "connect me to an agent",
      "need help from support",
      "help from support team",
      "need escalation",
      "professional help",
      "professional support",
      "agent assistance",
      "agent help",
      "technical support needed",
      "support ticket",
      "open a ticket",
      "raise a ticket",
      "raise an issue",
      "report issue",
      "report a problem",
      "report problem",
      "submit a ticket",
    ];

    const hasTicketKeyword = ticketKeywords.some((kw) =>
      messageLower.includes(kw)
    );

    if (hasTicketKeyword) {
      console.log("✅ Direct keyword match detected: ticket request");
      return true;
    }

    // If it looks like a plain informational query and has no ticket keyword, skip AI entirely
    if (looksLikeInfoQuery) {
      console.log("ℹ️ Informational query detected — skipping AI check");
      return false;
    }

    // --- 3. AI fallback — only for genuinely ambiguous messages ---
    const detectionPrompt = `You are a strict support-ticket intent classifier.

Your ONLY job: determine whether the customer is EXPLICITLY requesting to create a support ticket or speak with a human agent/support representative.

Customer message: "${messageBody}"

Answer YES only if the customer clearly wants to:
- Create or submit a support ticket
- Speak with or be connected to a human agent
- Escalate their issue to a support team member

Answer NO for:
- General questions or FAQs (e.g. about coverage, pricing, features, policies)
- Informational queries (e.g. "how does X work?", "what is your policy on Y?")
- Quick-reply button selections about product topics
- Any message that is simply asking for information, not requesting human intervention

Be strict. When in doubt, answer NO.

Respond ONLY with "yes" or "no". Nothing else.`;

    const response = await generateContent(detectionPrompt);
    const isYes = response.toLowerCase().trim() === "yes";

    console.log(
      isYes
        ? "✅ AI detected: ticket request"
        : "❌ AI detected: NOT a ticket request"
    );

    return isYes;
  } catch (err) {
    console.error("⚠️ Error detecting ticket request:", err.message);
    return false;
  }
}

/**
 * Handle the ESCALATE_TO_AGENT button press (or equivalent text payload).
 *
 * @param {string}   conversationId
 * @param {Map}      conversationFormData
 * @param {string}   activeSwitchboardIntegration  - unused; kept for API compatibility
 * @param {Function} sendMsg - sendSunshineMessage reference
 */
export async function handleEscalateToAgent(
  conversationId,
  conversationFormData,
  activeSwitchboardIntegration,
  sendMsg,
) {
  const formData = conversationFormData.get(conversationId);

  if (!formData?.data) {
    console.error("No form data found for escalation");
    try {
      await sendMsg(
        conversationId,
        "Sorry, I couldn't find your form data. Please try again.",
      );
    } catch (err) {
      console.error(`Could not send message: ${err.message}`);
    }
    return;
  }

  try {
    await escalateToAgent(conversationId, formData.data);
    conversationFormData.delete(conversationId);
  } catch (escalateErr) {
    console.error("Failed to escalate to agent:", escalateErr.message);
    try {
      await sendMsg(
        conversationId,
        "Sorry, there was an issue connecting you to an agent. Please try again.",
      );
    } catch (msgErr) {
      console.error(`Could not send error message: ${msgErr.message}`);
    }
  }
}

/**
 * Handle the CANCEL_ESCALATION button press (or equivalent text payload).
 *
 * @param {string}   conversationId
 * @param {Map}      conversationFormData
 * @param {Function} sendMsg
 */
export async function handleCancelEscalation(
  conversationId,
  conversationFormData,
  sendMsg,
) {
  conversationFormData.delete(conversationId);

  try {
    await sendMsg(
      conversationId,
      "No problem! Is there anything else I can help you with?",
    );
  } catch (err) {
    console.error(`Could not send message: ${err.message}`);
  }
}

/**
 * Handle the escalation check for a normal customer message.
 * If the customer wants a ticket, either show the form (first time) or escalate directly.
 *
 * @param {object}   opts
 * @param {string}   opts.conversationId
 * @param {string}   opts.messageBody
 * @param {string}   opts.userName
 * @param {Map}      opts.conversationFormData
 * @param {string}   opts.activeSwitchboardIntegration
 * @param {Function} opts.generateContent
 * @param {Function} opts.sendMsg
 * @returns {Promise<boolean>} true if the escalation path was taken
 */
export async function handleEscalationCheck({
  conversationId,
  messageBody,
  userName,
  conversationFormData,
  activeSwitchboardIntegration,
  generateContent,
  sendMsg,
}) {
  console.log(`🔍 Checking if ticket request: "${messageBody}"`);
  const wantsEscalation = await shouldCreateTicket(messageBody, generateContent);
  console.log(`📋 Ticket request detected: ${wantsEscalation}`);

  if (!wantsEscalation) return false;

  console.log("✅ Customer wants to create ticket, showing form...");
  const formData = conversationFormData.get(conversationId);
  const formStatus = formData?.status;

  // ── Case 1: Form already sent — waiting for customer to fill it ──────────
  if (formStatus === "pending_form") {
    console.log("⏳ Form already sent but not yet submitted — reminding customer");
    try {
      await sendMsg(
        conversationId,
        "Please fill out the form above so we can connect you with an agent. 😊",
      );
    } catch (err) {
      console.error("Failed to send form reminder:", err.message);
    }
    return true;
  }

  // ── Case 2: Form submitted, data ready — escalate directly ───────────────
  if (formStatus === "form_submitted" && formData?.data) {
    await escalateToAgent(conversationId, formData.data);
    conversationFormData.delete(conversationId);
    return true;
  }

  // ── Case 3: No recognised state (fresh conversation) — send the form ─────
  await sendDetailCollectionForm(conversationId);

  conversationFormData.set(conversationId, {
    status: "pending_form",
    initiatedBy: userName,
    timestamp: Date.now(),
  });

  // Auto-expire after 30 minutes
  setTimeout(
    () => conversationFormData.delete(conversationId),
    30 * 60 * 1000,
  );

  console.log("📨 Form sent to customer");
  return true;
}