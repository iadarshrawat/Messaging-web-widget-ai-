import dotenv from "dotenv";
import { generateContent } from "../config/openai.js";
import {
  handleEscalateToAgent,
  handleCancelEscalation,
  handleEscalationCheck,
} from "../methods/sunshine.js";
import {
  handleMetadataUpdated,
  handleFormResponse,
  isEscalationRequest,
  isEscalationCancellation,
  shouldSkipMessage,
  processCustomerMessage,
} from "../handlers/eventHandlers.js";
import {
  sendSunshineMessage,
} from "../utils/messageService.js";

dotenv.config();

// ─── Track form collection status per conversation ────────────────────────────
const conversationFormData = new Map();

/**
 * Main webhook handler for Sunshine conversations
 * Routes events to appropriate handlers
 */
export async function handleSunshineMessage(req, res) {
  try {
    const payload = req.body;
    // console.log("Received Sunshine webhook:", JSON.stringify(payload, null, 2));

    // Send 200 immediately so Zendesk doesn't timeout
    res.status(200).json({ success: true, received: true });

    if (
      !payload.events ||
      !Array.isArray(payload.events) ||
      payload.events.length === 0
    ) {
      console.error("Missing events in webhook payload");
      return;
    }

    setImmediate(async () => {
      try {
        for (const event of payload.events) {
          try {
            // Handle metadata updated (ticket creation)
            if (event.type === "conversation:updatedmetadata") {
              await handleMetadataUpdated(event, conversationFormData);
              continue;
            }

            // Only process conversation:message events
            if (event.type !== "conversation:message") continue;

            if (!event.payload?.conversation || !event.payload?.message) {
              console.error("Missing payload fields in event");
              continue;
            }

            await processMessageEvent(event, conversationFormData);
          } catch (eventErr) {
            console.error("Error processing event:", eventErr.message);
          }
        }
      } catch (processErr) {
        console.error("Error in background processing:", processErr.message);
      }
    });
  } catch (err) {
    console.error("Error in webhook handler:", err.message);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ error: "Failed to process message", details: err.message });
    }
  }
}

/**
 * Process a single message event
 */
async function processMessageEvent(event, conversationFormData) {
  const conversationId = event.payload.conversation.id;

  // Guard: skip if already being processed
  if (conversationFormData.get(conversationId)?.processing) {
    console.log(`Skipping duplicate event for conversation ${conversationId}`);
    return;
  }

  // Mark as processing
  const existingData = conversationFormData.get(conversationId);
  conversationFormData.set(conversationId, {
    ...existingData,
    processing: true,
  });

  const clearProcessing = () => {
    const d = conversationFormData.get(conversationId);
    if (!d) return;
    if (Object.keys(d).length === 1 && d.processing) {
      conversationFormData.delete(conversationId);
    } else {
      d.processing = false;
    }
  };

  try {
    const messageBody = event.payload.message.content?.text;
    const author = event.payload.message.author;
    const userName = author.displayName || "Customer";
    const activeSwitchboardIntegration =
      event.payload.conversation?.activeSwitchboardIntegration?.id ||
      event.payload.conversation?.activeSwitchboardIntegration?.name;

    // Skip bot/system/agent messages
    if (shouldSkipMessage(author)) {
      clearProcessing();
      return;
    }

    // Only process customer/user messages
    if (author.type !== "user" && author.type !== "end_user") {
      clearProcessing();
      return;
    }

    // Handle form submission
    if (
      event.payload.message.content?.type === "formResponse" &&
      event.payload.message.content?.fields
    ) {
      await handleFormResponse(
        event,
        conversationId,
        conversationFormData,
        userName,
      );
      clearProcessing();
      return;
    }

    // Skip if no message body
    if (!messageBody) {
      clearProcessing();
      return;
    }

    // Handle escalation requests (button press / keyword payload)
    if (isEscalationRequest(messageBody)) {
      await handleEscalateToAgent(
        conversationId,
        conversationFormData,
        activeSwitchboardIntegration,
        sendSunshineMessage,
      );
      clearProcessing();
      return;
    }

    // Handle escalation cancellation
    if (isEscalationCancellation(messageBody)) {
      await handleCancelEscalation(
        conversationId,
        conversationFormData,
        sendSunshineMessage,
      );
      clearProcessing();
      return;
    }

    // Check for free-text escalation requests via AI
    try {
      const escalated = await handleEscalationCheck({
        conversationId,
        messageBody,
        userName,
        conversationFormData,
        activeSwitchboardIntegration,
        generateContent,
        sendMsg: sendSunshineMessage,
      });

      if (escalated) {
        clearProcessing();
        return;
      }
    } catch (err) {
      console.error("Escalation check failed:", err.message);
      clearProcessing();
      return;
    }

    // Process customer message and generate bot reply
    await processCustomerMessage(
      event,
      conversationId,
      conversationFormData,
      activeSwitchboardIntegration,
    );

    clearProcessing();
  } catch (err) {
    console.error("Error in processMessageEvent:", err.message);
    const d = conversationFormData.get(conversationId);
    if (d) d.processing = false;
  }
}