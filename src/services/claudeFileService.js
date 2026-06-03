import { 
  createClaudeClient, 
  CLAUDE_CONFIG,
  FILE_BRAND_MAP,
  getBrandFromIntegrationId,
  sleep 
} from "../config/claude.js";

// ============================================================================
// FILE MANAGEMENT
// ============================================================================

/**
 * Fetch all uploaded files from Claude
 * Populates FILE_BRAND_MAP with file metadata
 * @returns {Promise<Array>} Array of file objects with metadata
 */
export async function fetchClaudeFiles() {
  try {
    const client = createClaudeClient();
    
    console.log("📂 Fetching uploaded files from Claude...");
    
    const response = await client.get('/files');
    const files = response.data.data || [];
    
    console.log(`✅ Found ${files.length} uploaded file(s)`);
    
    // Log each file
    for (const file of files) {
      console.log(`   📄 ${file.filename} (${file.size_bytes} bytes)`);
      console.log(`      ID: ${file.id}`);
      console.log(`      Uploaded: ${file.created_at}`);
    }
    
    return files;
  } catch (err) {
    console.error("❌ Error fetching Claude files:", err.message);
    if (err.response?.status === 401) {
      throw new Error("Claude authentication failed - check ANTHROPIC_API_KEY");
    }
    throw err;
  }
}

/**
 * Map uploaded files to brands based on filename
 * @param {Array} files - Array of file objects from Claude
 * @returns {Promise<Object>} Mapping of file IDs to brand info
 */
export async function mapFilesToBrands(files) {
  try {
    console.log("🔍 Mapping files to brands...");
    
    // Brand identifiers - can be customized based on your filenames
    const brandPatterns = {
      'Affinity': ['affinity', 'affnity'],  // Handle typo variations
      'Ethos': ['ethos'],
      'ITBytes': ['itbytes', 'it-bytes', 'it_bytes'],
    };
    
    for (const file of files) {
      const filename = file.filename.toLowerCase();
      let brand = 'Unknown';
      
      // Find matching brand
      for (const [brandName, patterns] of Object.entries(brandPatterns)) {
        if (patterns.some(pattern => filename.includes(pattern))) {
          brand = brandName;
          break;
        }
      }
      
      // Store in FILE_BRAND_MAP
      FILE_BRAND_MAP[file.id] = {
        brand,
        filename: file.filename,
        size: file.size_bytes,
        createdAt: file.created_at,
        mimeType: file.mime_type,
      };
      
      console.log(`   ✅ ${file.filename} → ${brand}`);
    }
    
    return FILE_BRAND_MAP;
  } catch (err) {
    console.error("❌ Error mapping files to brands:", err.message);
    throw err;
  }
}

/**
 * Initialize file mapping on startup
 * Call this once when the server starts
 */
export async function initializeFileMapping() {
  try {
    const files = await fetchClaudeFiles();
    await mapFilesToBrands(files);
    console.log("✅ File mapping initialized successfully");
    return true;
  } catch (err) {
    console.error("❌ Failed to initialize file mapping:", err.message);
    return false;
  }
}

// ============================================================================
// FILE SEARCH & CONTENT
// ============================================================================

/**
 * Search knowledge base file using Claude
 * Sends file content + question to Claude to find answer
 * @param {string} fileId - Claude file ID to search
 * @param {string} question - Customer's question
 * @returns {Promise<Object>} Search result with answer and confidence
 */
export async function searchFileWithClaude(fileId, question) {
  try {
    if (!fileId) {
      throw new Error("File ID is required");
    }
    if (!question) {
      throw new Error("Question is required");
    }

    const client = createClaudeClient();
    const fileInfo = FILE_BRAND_MAP[fileId];
    
    if (!fileInfo) {
      console.warn(`⚠️ File ${fileId} not found in mapping`);
    }

    console.log(`🔍 Searching file ${fileId} for: "${question}"`);

    // Build the prompt for Claude
    const searchPrompt = `You are a helpful customer support assistant. A customer from the ${fileInfo?.brand || 'unknown brand'} has asked the following question.

CUSTOMER QUESTION:
"${question}"

Please search through the provided document and find the most relevant answer to this question. 

IMPORTANT INSTRUCTIONS:
1. If you find a relevant answer in the document, provide it clearly
2. If the answer is not in the document, say "I don't have information about that topic in our knowledge base"
3. Keep your answer concise and helpful
4. If multiple answers are relevant, provide the most specific one`;

    // Call Claude with file reference
    const response = await client.post('/messages', {
      model: CLAUDE_CONFIG.model,
      max_tokens: CLAUDE_CONFIG.maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: searchPrompt,
            },
            {
              type: 'document',
              source: {
                type: 'file',
                file_id: fileId,
              },
            },
          ],
        },
      ],
    });

    // Extract the response
    const answer = response.data.content[0]?.text || '';
    
    // Determine confidence based on answer
    const confidence = answer.includes("don't have information") ? 0.3 : 0.8;

    console.log(`✅ Found answer (confidence: ${confidence})`);

    return {
      fileId,
      brand: fileInfo?.brand,
      question,
      answer,
      confidence,
      found: confidence > 0.5,
    };
  } catch (err) {
    console.error(`❌ Error searching file ${fileId}:`, err.message);
    throw err;
  }
}

/**
 * Search all files for a specific brand
 * @param {string} brand - Brand name (Affinity, Ethos, ITBytes)
 * @param {string} question - Customer's question
 * @returns {Promise<Array>} Array of search results
 */
export async function searchBrandFiles(brand, question) {
  try {
    console.log(`🔍 Searching files for brand: ${brand}`);
    
    // Get all file IDs for this brand
    const fileIds = Object.entries(FILE_BRAND_MAP)
      .filter(([_, info]) => info.brand === brand)
      .map(([id, _]) => id);
    
    if (fileIds.length === 0) {
      console.warn(`⚠️ No files found for brand: ${brand}`);
      return [];
    }

    console.log(`📂 Found ${fileIds.length} file(s) for ${brand}`);

    // Search each file
    const results = [];
    for (const fileId of fileIds) {
      try {
        const result = await searchFileWithClaude(fileId, question);
        results.push(result);
        
        // Add delay between searches to avoid rate limiting
        await sleep(500);
      } catch (err) {
        console.error(`⚠️ Error searching file ${fileId}:`, err.message);
      }
    }

    // Sort by confidence (highest first)
    results.sort((a, b) => b.confidence - a.confidence);

    return results;
  } catch (err) {
    console.error("❌ Error searching brand files:", err.message);
    throw err;
  }
}

/**
 * Get the best answer from search results
 * @param {Array} results - Array of search results
 * @returns {Object|null} Best result or null if none found
 */
export function getBestAnswer(results) {
  if (!results || results.length === 0) {
    return null;
  }

  // Find first result with confidence > 0.5
  const highConfidence = results.find(r => r.confidence > 0.5);
  if (highConfidence) {
    return highConfidence;
  }

  // Otherwise return highest confidence result
  return results[0];
}

// ============================================================================
// KNOWLEDGE BASE SEARCH (Unified interface)
// ============================================================================

/**
 * Search knowledge base for answer to customer question
 * Replaces the old Pinecone-based search
 * 
 * @param {string} integrationId - Sunshine integration ID (to determine brand)
 * @param {string} question - Customer's question
 * @returns {Promise<Object>} Search result with answer
 */
export async function searchKnowledgeBase(integrationId, question) {
  try {
    if (!integrationId || !question) {
      throw new Error("Integration ID and question are required");
    }

    // Step 1: Determine which brand this customer belongs to
    const brand = getBrandFromIntegrationId(integrationId);
    
    if (brand === 'Unknown') {
      console.warn(`⚠️ Unknown integration ID: ${integrationId}`);
      return {
        found: false,
        answer: "I'm sorry, I couldn't determine which brand you're from.",
        brand: 'Unknown',
      };
    }

    console.log(`👤 Customer from ${brand} asked: "${question}"`);

    // Step 2: Search all files for this brand
    const results = await searchBrandFiles(brand, question);

    // Step 3: Get the best answer
    const bestAnswer = getBestAnswer(results);

    if (bestAnswer && bestAnswer.found) {
      return {
        found: true,
        answer: bestAnswer.answer,
        brand: bestAnswer.brand,
        fileId: bestAnswer.fileId,
        confidence: bestAnswer.confidence,
      };
    }

    return {
      found: false,
      answer: "I don't have information about that topic. Please contact our support team.",
      brand,
    };
  } catch (err) {
    console.error("❌ Knowledge base search error:", err.message);
    throw err;
  }
}

export { FILE_BRAND_MAP };
