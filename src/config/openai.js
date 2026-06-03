import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// ============================================================================
// CONFIGURATION & VALIDATION
// ============================================================================

/**
 * OpenAI Configuration
 * 
 * Used for:
 * - Generating LLM responses for customer support
 * - Analyzing customer intent (e.g., should escalate?)
 * - Processing natural language queries
 * 
 * Required environment variables:
 * - OPENAI_API_KEY: API key from OpenAI (https://platform.openai.com)
 * 
 * Optional environment variables:
 * - OPENAI_MODEL: Default model name (default: "gpt-4-turbo")
 * - OPENAI_TEMPERATURE: Model creativity 0-1 (default: 0.7)
 * - OPENAI_MAX_TOKENS: Max response tokens (default: 2000)
 * - OPENAI_TIMEOUT: Request timeout in ms (default: 60000)
 */
export const OPENAI_CONFIG = {
  apiKey: process.env.OPENAI_API_KEY || '',
  defaultModel: process.env.OPENAI_MODEL || "gpt-4-turbo",
  baseUrl: "https://api.openai.com/v1",
  temperature: parseFloat(process.env.OPENAI_TEMPERATURE) || 0.7,
  topP: 0.8,
  maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS) || 2000,
  timeout: parseInt(process.env.OPENAI_TIMEOUT) || 60000, // 60 seconds
};

/**
 * Generation configuration presets
 */
export const GENERATION_PRESETS = {
  // For support responses - balanced temperature
  support: {
    temperature: 0.7,
    maxTokens: 2000,
    topP: 0.8,
  },
  // For intent detection - low temperature (deterministic)
  detection: {
    temperature: 0.1,
    maxTokens: 100,
    topP: 0.5,
  },
  // For creative responses - higher temperature
  creative: {
    temperature: 0.9,
    maxTokens: 2500,
    topP: 0.95,
  },
};

// Validate configuration
if (!OPENAI_CONFIG.apiKey) {
  console.error("❌ OPENAI_API_KEY missing from environment");
  process.exit(1);
}

/**
 * Generate content with OpenAI
 * @param {string} prompt - The prompt to generate from
 * @param {object} config - Optional generation config
 * @param {string} modelName - Model to use (default: from config)
 * @returns {Promise<string>} Generated content
 * @throws {Error} If generation fails
 */
export async function generateContent(prompt, config = {}, modelName = null) {
  const model = modelName || OPENAI_CONFIG.defaultModel;
  
  const settings = {
    temperature: config.temperature ?? OPENAI_CONFIG.temperature,
    top_p: config.topP ?? OPENAI_CONFIG.topP,
    max_tokens: config.maxTokens ?? OPENAI_CONFIG.maxTokens,
  };

  try {
    const response = await axios.post(
      `${OPENAI_CONFIG.baseUrl}/chat/completions`,
      {
        model: model,
        messages: [
          {
            role: "system",
            content: "You are a helpful customer support assistant. Provide clear, concise, and helpful responses."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: settings.temperature,
        top_p: settings.top_p,
        max_tokens: settings.max_tokens,
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENAI_CONFIG.apiKey}`,
          "Content-Type": "application/json"
        },
        timeout: OPENAI_CONFIG.timeout,
      }
    );

    if (!response.data.choices || response.data.choices.length === 0) {
      throw new Error("No choices in OpenAI response");
    }

    return response.data.choices[0].message.content;
  } catch (error) {
    if (error.response?.status === 429) {
      throw new Error(`OpenAI rate limited: ${error.message}`);
    } else if (error.response?.status === 401) {
      throw new Error(`OpenAI authentication failed: Invalid API key`);
    } else if (error.response?.status === 500) {
      throw new Error(`OpenAI server error: ${error.message}`);
    } else {
      throw new Error(`OpenAI generation failed: ${error.message}`);
    }
  }
}

/**
 * List available models (for debugging)
 */
export async function listAvailableModels() {
  try {
    const response = await axios.get(
      `${OPENAI_CONFIG.baseUrl}/models`,
      {
        headers: {
          "Authorization": `Bearer ${OPENAI_CONFIG.apiKey}`
        }
      }
    );
    
    // Models available but not logged to reduce noise
  } catch (error) {
    console.error("Could not list models:", error.message);
  }
}


