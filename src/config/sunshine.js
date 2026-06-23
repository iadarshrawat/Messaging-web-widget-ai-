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

export { isConfigured };
