import { getTicket } from "../services/ticketManager.js";

import {
  sendSunshineMessage,
  getConversationHistory,
  generateReplyWithClaude,
  getBrandFromWidgetId,
} from "../utils/messageService.js";
import { generateContextualQuickReplies } from "../utils/quickReplyService.js";

/**
 * Handle conversation metadata updated event (ticket creation)
 * @param {object} event
 * @param {Map} conversationFormData
 */
export async function handleMetadataUpdated(event, conversationFormData) {
  try {
    const conversationId = event.payload.conversation?.id;
    const metadata = event.payload.conversation?.metadata;
    const ticketId = metadata?.["zd:ticket"]?.id;

    if (ticketId && conversationId) {
      try {
        const formData = conversationFormData.get(conversationId);

        if (formData?.data) {
          const { name, email } = formData.data;
          console.log(
            `✅ Ticket ${ticketId} created with customer: ${name} (${email})`,
          );
          const ticket = await getTicket(ticketId);
          console.log(`Ticket requester ID: ${ticket.requester_id}`);
        } else {
          console.log(
            `ℹ️ Ticket ${ticketId} created but no form data found for conversation ${conversationId}`,
          );
        }

        conversationFormData.delete(conversationId);
      } catch (err) {
        console.error("Could not process ticket:", err.message);
      }
    }
  } catch (err) {
    console.error("Error handling metadata update:", err.message);
  }
}

/**
 * Handle form response submission
 * @param {object} event
 * @param {string} conversationId
 * @param {Map} conversationFormData
 * @param {string} userName
 */
export async function handleFormResponse(
  event,
  conversationId,
  conversationFormData,
  userName,
) {
  try {
    const fields = event.payload.message.content?.fields || [];
    const author = event.payload.message.author;

    const customerName =
      fields.find((f) => f.name === "name")?.text || userName || "Customer";
    const customerEmail =
      fields.find((f) => f.name === "email")?.email ||
      process.env.ZENDESK_EMAIL;
    const issueCategory =
      fields.find((f) => f.name === "category")?.select?.[0]?.name ||
      "general";
    const issueDescription =
      fields.find((f) => f.name === "description")?.text ||
      "No description provided";
    const webUserId = author.userId;

    conversationFormData.set(conversationId, {
      status: "form_submitted",
      data: {
        name: customerName,
        email: customerEmail,
        category: issueCategory,
        description: issueDescription,
        webUserId,
      },
      submittedAt: Date.now(),
    });

    // Send escalation options
    try {
      await sendSunshineMessage(conversationId, {
        text: `Thank you ${customerName}! Would you like to escalate to a human agent to discuss your ${issueCategory} issue?`,
        quickReplies: [
          "✅ Yes, Connect me to Agent",
          "❌ No, Cancel",
        ],
      });
    } catch (err) {
      console.error("Failed to send form response message:", err.message);
    }
  } catch (err) {
    console.error("Error handling form response:", err.message);
  }
}

/**
 * Check if message is escalation request or button press
 * @param {string} messageBody
 * @returns {boolean}
 */
export function isEscalationRequest(messageBody) {
  return (
    messageBody === "ESCALATE_TO_AGENT" ||
    messageBody === "✅ Yes, Connect me to Agent"
  );
}

/**
 * Check if message is escalation cancellation
 * @param {string} messageBody
 * @returns {boolean}
 */
export function isEscalationCancellation(messageBody) {
  return (
    messageBody === "CANCEL_ESCALATION" ||
    messageBody === "❌ No, Cancel"
  );
}

/**
 * Handle message that should skip bot processing
 * @param {object} author
 * @returns {boolean}
 */
export function shouldSkipMessage(author) {
  return (
    author.type === "business" ||
    author.displayName?.includes("BOT") ||
    author.displayName?.includes("bot") ||
    author.subtypes?.includes("AI")
  );
}

/**
 * Check if agent is currently handling the conversation
 * @param {string} activeSwitchboardIntegration
 * @returns {boolean}
 */
export function isAgentActive(activeSwitchboardIntegration) {
  return (
    activeSwitchboardIntegration &&
    (activeSwitchboardIntegration.includes("agentWorkspace") ||
      activeSwitchboardIntegration === "zd-agentWorkspace" ||
      activeSwitchboardIntegration.includes("agent"))
  );
}

/**
 * Process regular customer message and generate bot reply
 * Optimized for speed: Send message first, attach quick replies later
 * @param {object} event
 * @param {string} conversationId
 * @param {Map} conversationFormData
 * @param {string} activeSwitchboardIntegration
 */
export async function processCustomerMessage(
  event,
  conversationId,
  conversationFormData,
  activeSwitchboardIntegration,
) {
  const messageBody = event.payload.message.content?.text;
  const author = event.payload.message.author;
  const userName = author.displayName || "Customer";

  // Skip if agent is handling
  if (isAgentActive(activeSwitchboardIntegration)) {
    console.log(`Skipping bot reply — agent active or escalated`);
    return;
  }

  // Get brand first (needed for both bot reply and quick replies)
  const brand = getBrandFromWidgetId(event.payload.conversation.brandId);
  console.log(`Processing message for brand: ${brand}`);

  // Step 1: Generate bot reply
  let botReply;
  try {
    const history = await getConversationHistory(conversationId);
    botReply = await generateReplyWithClaude(brand, history, messageBody);
  } catch (err) {
    console.error("Claude generation error:", err.message);
    botReply =
      "I'm sorry, I encountered an issue generating a response. Please try again.";
  }

  try {
    // Step 2: Start quick replies generation in parallel (don't wait)
    // Pass the brand so it can use the correct knowledge base file
    const quickRepliesPromise = generateContextualQuickReplies(
      messageBody,
      botReply,
      brand,
    ).catch((err) => {
      console.error("Quick replies error (non-blocking):", err.message);
      return []; // Return empty array on error
    });

    // Step 3: Send bot reply immediately (don't wait for quick replies)
    console.log(`📤 Sending bot reply immediately...`);
    await sendSunshineMessage(conversationId, { text: botReply });

    // Step 4: Get quick replies when ready and send them
    const quickReplies = await quickRepliesPromise;
    if (quickReplies && quickReplies.length > 0) {
      console.log(
        `📌 Attaching quick replies: ${JSON.stringify(quickReplies)}`,
      );
      // Note: Zendesk Sunshine API doesn't support editing messages to add replies
      // So we send quick replies as a follow-up message if needed
      // For now, this is just logged
    }
  } catch (err) {
    console.error("Failed to send reply:", err.message);
    try {
      await sendSunshineMessage(conversationId, botReply);
    } catch (fallbackErr) {
      console.error("Fallback send also failed:", fallbackErr.message);
    }
  } 
}
