import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// ============================================================================
// CONFIGURATION & VALIDATION
// ============================================================================

/**
 * Claude AI Configuration
 * 
 * Uses Claude's Files API to manage knowledge base documents
 * and Messages API to search/query them.
 * 
 * Required environment variables:
 * - ANTHROPIC_API_KEY: API key from Anthropic (https://console.anthropic.com)
 * 
 * Optional environment variables:
 * - CLAUDE_MODEL: Model to use (default: "claude-opus-4-1")
 * - CLAUDE_MAX_TOKENS: Max tokens in response (default: 2048)
 */
export const CLAUDE_CONFIG = {
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.CLAUDE_MODEL || 'claude-opus-4-1',
  baseUrl: 'https://api.anthropic.com/v1',
  version: '2023-06-01',
  beta: 'files-api-2025-04-14',
  maxTokens: parseInt(process.env.CLAUDE_MAX_TOKENS) || 2048,
};

/**
 * Integration ID to Brand Name Mapping
 * Maps Sunshine widget integration IDs to brand names
 * 
 * Used to determine which knowledge base file to search for each customer
 */
export const INTEGRATION_BRAND_MAP = {
  // Format: 'integration_id': 'Brand Name'
  [process.env.INTEGRATION_ID_AFFINITY || 'default_affinity']: 'Affinity',
  [process.env.INTEGRATION_ID_ETHOS || 'default_ethos']: 'Ethos',
  [process.env.INTEGRATION_ID_ITBYTES || 'default_itbytes']: 'ITBytes',
};

/**
 * File ID to Brand Mapping
 * Maps uploaded file IDs to their corresponding brands
 * 
 * This gets populated when files are fetched from Claude
 * Format: 'file_id': { brand, filename, size }
 */
export const FILE_BRAND_MAP = {};

/**
 * Validate Claude configuration on startup
 */
function validateClaudeConfig() {
  const required = ['ANTHROPIC_API_KEY'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.warn("⚠️ Anthropic Claude credentials missing");
    console.warn(`💡 Missing: ${missing.join(', ')}`);
    console.warn("💡 Claude file-based KB search will not work");
    return false;
  }
  return true;
}

// Validate on import
const isConfigured = validateClaudeConfig();

// ============================================================================
// CLAUDE API CLIENT
// ============================================================================

/**
 * Create Claude API client for Files and Messages APIs
 * @throws {Error} If Claude credentials not configured
 */
export function createClaudeClient() {
  if (!isConfigured) {
    throw new Error(
      "Anthropic Claude credentials not configured. Set ANTHROPIC_API_KEY in .env"
    );
  }

  return axios.create({
    baseURL: CLAUDE_CONFIG.baseUrl,
    headers: {
      'x-api-key': CLAUDE_CONFIG.apiKey,
      'anthropic-version': CLAUDE_CONFIG.version,
      'anthropic-beta': CLAUDE_CONFIG.beta,
      'content-type': 'application/json',
    },
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get brand name from integration ID
 * @param {string} integrationId - Sunshine integration ID
 * @returns {string} Brand name (Affinity, Ethos, ITBytes, or Unknown)
 */
export function getBrandFromIntegrationId(integrationId) {
  return INTEGRATION_BRAND_MAP[integrationId] || 'Unknown';
}


/**
 * Sleep utility for rate limiting and retries
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { isConfigured };
