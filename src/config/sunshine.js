import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// ============================================================================
// CONFIGURATION & VALIDATION
// ============================================================================

/**
 * Zendesk Sunshine Conversations API Configuration
 * 
 * Sunshine (Smooch v2) allows building custom chatbots and conversational widgets.
 * 
 * Required environment variables:
 * - SUNSHINE_KEY_ID: API key ID from Zendesk Sunshine
 * - SUNSHINE_KEY_SECRET: API key secret from Zendesk Sunshine
 * - SUNSHINE_APP_ID: Your Sunshine app ID
 * - SUNSHINE_INTEGRATION_ID: (Optional) Custom integration ID
 */
export const SUNSHINE_CONFIG = {
  keyId: process.env.SUNSHINE_KEY_ID || '',
  keySecret: process.env.SUNSHINE_KEY_SECRET || '',
  appId: process.env.SUNSHINE_APP_ID || '',
  integrationId: process.env.SUNSHINE_INTEGRATION_ID || 'sunshine-AI-webhook',
  baseUrl: 'https://api.smooch.io/v2',
  agentWorkspaceId: 'zd-agentWorkspace',
};

/**
 * Validate Sunshine configuration on startup
 */
function validateSunshineConfig() {
  const required = ['SUNSHINE_KEY_ID', 'SUNSHINE_KEY_SECRET', 'SUNSHINE_APP_ID'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.warn("⚠️ Zendesk Sunshine credentials missing");
    console.warn(`💡 Missing: ${missing.join(', ')}`);
    console.warn("💡 Sunshine webhook and bot features will not work");
    return false;
  }
  return true;
}

// Validate on import
const isConfigured = validateSunshineConfig();

// ============================================================================
// SUNSHINE API CLIENT
// ============================================================================

/**
 * Create Sunshine Conversations API client
 * Uses Basic Auth with Key ID + Key Secret
 * Base URL: https://api.smooch.io/v2
 */
export function createSunshineClient() {
  if (!process.env.SUNSHINE_KEY_ID || !process.env.SUNSHINE_KEY_SECRET) {
    throw new Error(
      "Zendesk Sunshine credentials not configured. Need SUNSHINE_KEY_ID and SUNSHINE_KEY_SECRET",
    );
  }

  return axios.create({
    baseURL: `https://api.smooch.io/v2`,
    headers: {
      "Content-Type": "application/json",
    },
    auth: {
      username: process.env.SUNSHINE_KEY_ID,
      password: process.env.SUNSHINE_KEY_SECRET,
    },
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Sleep utility for rate limiting and retries
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if a Switchboard Integration indicates agent is active
 * @param {string} activeSwitchboardIntegration - Integration ID or name
 * @returns {boolean} True if agent is active
 */
export function isAgentActive(activeSwitchboardIntegration) {
  if (!activeSwitchboardIntegration) return false;

  return (
    activeSwitchboardIntegration.includes("agentWorkspace") ||
    activeSwitchboardIntegration === SUNSHINE_CONFIG.agentWorkspaceId ||
    activeSwitchboardIntegration.includes("agent")
  );
}

/**
 * Check if message author is a customer (not bot/agent/system)
 * @param {object} author - Message author object from Sunshine
 * @returns {boolean} True if author is a customer
 */
export function isCustomerMessage(author) {
  if (author.type === "business") return false;
  if (author.displayName?.includes("BOT") || author.displayName?.includes("bot")) return false;
  if (author.subtypes?.includes("AI")) return false;
  if (author.type !== "user" && author.type !== "end_user") return false;

  return true;
}

/**
 * Check if message body is a quick reply payload
 * @param {string} messageBody - Message text
 * @returns {boolean} True if message is a quick reply action
 */
export function isQuickReplyPayload(messageBody) {
  return (
    messageBody === "ESCALATE_TO_AGENT" ||
    messageBody === "✅ Yes, Connect me to Agent" ||
    messageBody === "CANCEL_ESCALATION" ||
    messageBody === "❌ No, Cancel"
  );
}

export { isConfigured };
