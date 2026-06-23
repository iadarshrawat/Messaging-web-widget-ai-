import { getTicket, updateTicketRequester } from "../services/ticketManager.js";

import {
  sendSunshineMessage,
  getConversationHistory,
  generateReplyWithClaude,
  getBrandFromWidgetId,
  sendTypingIndicator,
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

    console.log(`🔔 metadata_updated event for conversation ${conversationId} - metadata keys: ${Object.keys(metadata || {}).join(', ')}`);
    console.log(`🔔 zd:ticket metadata: ${JSON.stringify(metadata?.['zd:ticket'] || {})}`);

    if (ticketId && conversationId) {
      try {
        const formData = conversationFormData.get(conversationId);

        console.log(`🔎 conversationFormData.get(${conversationId}) => ${JSON.stringify(formData || null)}`);

        if (formData?.data) {
          const { name, email } = formData.data;
          console.log(
            `✅ Ticket ${ticketId} created with customer: ${name} (${email})`,
          );
          
          // ✅ NEW: Update the ticket requester with the customer email
          try {
            await updateTicketRequester(ticketId, email, name);
          } catch (err) {
            console.error(`⚠️ Failed to update ticket requester:`, err.response?.data || err.message);
            // Don't throw — continue even if requester update fails
          }

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

    // Helper to robustly extract a value from a form field which may
    // come in different shapes depending on the Sunshine payload.
    const getField = (fieldName) => fields.find((f) => f.name === fieldName) || null;
    const extractValue = (field) => {
      if (!field) return null;
      // Try several common properties
      return (
        field.email ||
        field.text ||
        field.value ||
        // select may contain an array with an object
        (field.select && field.select[0] && (field.select[0].value || field.select[0].email || field.select[0].name)) ||
        null
      );
    };

    const customerName = extractValue(getField("name")) || userName || "Customer";
    const extractedEmail = extractValue(getField("email"));
    const customerEmail = extractedEmail || process.env.DEFAULT_FORM_EMAIL || process.env.ZENDESK_EMAIL;
    console.log(`🔎 Extracted form email: ${extractedEmail} — using: ${customerEmail}`);
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
  // Inform the user the bot is typing while we generate a reply
  const userId = author.userId || null;
  console.log(`Attempting typing:start for conversation=${conversationId} userId=${userId}`);
  await sendTypingIndicator(conversationId, 'start', userId).catch((e) => { console.warn('sendTypingIndicator(start) error:', e?.response?.data || e?.message || e); });

  const history = await getConversationHistory(conversationId);
  botReply = await generateReplyWithClaude(brand, history, messageBody);

  // Stop typing indicator before sending the reply
  console.log(`Attempting typing:stop for conversation=${conversationId} userId=${userId}`);
  await sendTypingIndicator(conversationId, 'stop', userId).catch((e) => { console.warn('sendTypingIndicator(stop) error:', e?.response?.data || e?.message || e); });
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
        `📌 Quick replies ready: ${JSON.stringify(quickReplies)}`,
      );
      // Send quick replies as follow-up message with structured action buttons
      try {
        // Add a small delay to ensure message ordering
        await new Promise((r) => setTimeout(r, 100));
        
        // Send quick replies as a structured message
        await sendSunshineMessage(conversationId, {
          text: "What would you like to know next?",
          quickReplies: quickReplies,
        });
        console.log(`✅ Quick replies sent successfully`);
      } catch (qrErr) {
        console.error("⚠️ Failed to send quick replies:", qrErr.message);
        // Don't fail the entire operation if quick replies fail
      }
    } else {
      console.log(`ℹ️ No quick replies generated (empty array or error)`);
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
