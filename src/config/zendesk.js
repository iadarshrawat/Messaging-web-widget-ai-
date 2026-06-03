import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// ============================================================================
// CONFIGURATION & VALIDATION
// ============================================================================

/**
 * Zendesk API Configuration
 * Required environment variables:
 * - ZENDESK_EMAIL: Email for Zendesk API access
 * - ZENDESK_API_TOKEN: API token from Zendesk
 * - ZENDESK_DOMAIN: Your Zendesk subdomain (e.g., 'company' from company.zendesk.com)
 * - ZENDESK_BRAND_ID: (Optional) Specific brand ID for ticket operations
 */
export const ZENDESK_CONFIG = {
  email: process.env.ZENDESK_EMAIL || '',
  apiToken: process.env.ZENDESK_API_TOKEN || '',
  domain: process.env.ZENDESK_DOMAIN || '',
  brandId: process.env.ZENDESK_BRAND_ID || null,
  baseUrl: process.env.ZENDESK_DOMAIN 
    ? `https://${process.env.ZENDESK_DOMAIN}.zendesk.com` 
    : null,
};

/**
 * Validate Zendesk configuration on startup
 */
function validateZendeskConfig() {
  const required = ['ZENDESK_EMAIL', 'ZENDESK_API_TOKEN', 'ZENDESK_DOMAIN'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.warn("⚠️ Zendesk credentials missing - auto-import feature will not work");
    console.warn(`💡 Missing: ${missing.join(', ')}`);
    console.warn("💡 Add to .env file: ZENDESK_EMAIL, ZENDESK_API_TOKEN, ZENDESK_DOMAIN");
    return false;
  }
  return true;
}

// Validate on import
const isConfigured = validateZendeskConfig();

/**
 * Create Zendesk API client
 * Uses Basic Auth with email/token
 * @throws {Error} If Zendesk credentials not configured
 */
export function createZendeskClient() {
  if (!isConfigured) {
    throw new Error("Zendesk credentials not configured. Set ZENDESK_EMAIL, ZENDESK_API_TOKEN, and ZENDESK_DOMAIN in .env");
  }

  const auth = Buffer.from(
    `${ZENDESK_CONFIG.email}/token:${ZENDESK_CONFIG.apiToken}`
  ).toString('base64');

  return axios.create({
    baseURL: `${ZENDESK_CONFIG.baseUrl}/api/v2`,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * Fetch tickets using SEARCH API with DATE FILTERING
 * Handles Zendesk's 1000 ticket limit by rolling the start date
 */
export async function fetchTicketsByDateRange(startDate, endDate) {
  const zendeskClient = createZendeskClient();

  const formatDate = (dateStr) => new Date(dateStr).toISOString().split('T')[0];

  let currentStart = formatDate(startDate);
  const endFormatted = formatDate(endDate);

  console.log(`📅 Fetching tickets from ${currentStart} → ${endFormatted}`);

  let allTickets = [];
  let batchCount = 0;

  while (true) {
    batchCount++;
    console.log(`\n🔄 Batch ${batchCount} | Range: ${currentStart} → ${endFormatted}`);

    const query = `type:ticket created>=${currentStart} created<=${endFormatted}`;
    const encodedQuery = encodeURIComponent(query);

    let page = 1;
    let batchTickets = [];
    let lastTicketTimestamp = null;
    let hitPageLimit = false;

    // Paginate up to page 10 (max 1000 tickets)
    while (page <= 10) {
      console.log(`   📄 Page ${page}...`);

      try {
        const res = await zendeskClient.get(
          `/search.json?query=${encodedQuery}&sort_by=created_at&sort_order=asc&page=${page}&per_page=100`
        );

        const results = res.data.results || [];
        console.log(`      ✓ ${results.length} tickets`);

        batchTickets.push(...results);

        if (results.length > 0) {
          lastTicketTimestamp = results[results.length - 1].created_at;
        }

        // Less than 100 results = last page, we're done
        if (results.length < 100) {
          console.log(`      ✓ Last page reached`);
          break;
        }

        // Hit page 10 = about to hit 1000 limit, roll timestamp
        if (page === 10) {
          console.log(`   ⚠️  Reached page 10 (1000 ticket limit) → rolling timestamp`);
          hitPageLimit = true;
          break;
        }

        page++;
        await sleep(300);

      } catch (err) {
        if (err.response?.status === 429) {
          const wait = parseInt(err.response.headers?.['retry-after'] || 60) * 1000;
          console.warn(`   ⚠️ Rate limited → waiting ${wait / 1000}s`);
          await sleep(wait);
          continue;
        }

        console.error(`   ❌ Error on page ${page}:`, err.message);
        break;
      }
    }

    console.log(`   ✅ Batch fetched: ${batchTickets.length} tickets`);
    allTickets.push(...batchTickets);

    // If we didn't hit the limit, we're fully done
    if (!hitPageLimit) {
      console.log(`\n✅ All tickets fetched`);
      break;
    }

    // Roll the timestamp to the last ticket's created_at + 1 second
    if (lastTicketTimestamp) {
      const nextStart = new Date(new Date(lastTicketTimestamp).getTime() + 1000);
      currentStart = nextStart.toISOString().split('T')[0];

      console.log(`   🔄 Rolling start date to: ${currentStart}`);

      // Safety: if rolled date exceeds end date, stop
      if (new Date(currentStart) > new Date(endFormatted)) {
        console.log(`   ✓ Rolled past end date → done`);
        break;
      }

      await sleep(500);
    } else {
      // No tickets found, stop
      break;
    }
  }

  console.log(`\n✅ Total tickets fetched: ${allTickets.length}`);
  return allTickets;
}

/**
 * Cache for form fields (to avoid redundant API calls)
 */
let formFieldsCache = null;

/**
 * Fetch all ticket form fields with retry logic for rate limiting
 */
export async function fetchFormFields() {
  // Return cached fields if available
  if (formFieldsCache) {
    console.log(`📋 Using cached form fields (${Object.keys(formFieldsCache).length} fields)`);
    return formFieldsCache;
  }

  const zendeskClient = createZendeskClient();
  const fieldsMap = {};
  const MAX_RETRIES = 5;
  const INITIAL_RETRY_DELAY = 2000;
  const RATE_LIMIT_DELAY = 120000; // 2 minutes for 429 errors
  
  try {
    console.log(`📋 Fetching ticket form fields...`);
    
    let nextUrl = '/ticket_fields.json';
    let page = 1;
    let totalFields = 0;
    
    while (nextUrl) {
      let retryCount = 0;
      let success = false;
      let lastError = null;
      
      while (retryCount < MAX_RETRIES && !success) {
        try {
          const response = await zendeskClient.get(nextUrl);
          const fields = response.data.ticket_fields || [];
          
          // Map field ID to field details (id, title, type, description)
          for (const field of fields) {
            fieldsMap[field.id] = {
              id: field.id,
              title: field.title,
              type: field.type,
              description: field.description || '',
              system: field.system,
              key: field.key || ''
            };
          }
          
          totalFields += fields.length;
          console.log(`   ✓ Fetched ${fields.length} fields on page ${page}`);
          
          nextUrl = response.data.next_page || null;
          page++;
          success = true;
          
          // Delay between pages
          if (nextUrl) {
            await sleep(500);
          }
          
        } catch (err) {
          lastError = err;
          const status = err.response?.status;
          const retryAfter = err.response?.headers?.['retry-after'];
          
          // Handle rate limiting (429 Too Many Requests)
          if (status === 429) {
            retryCount++;
            
            // For 429 errors, wait 2 minutes (120 seconds) to reset quota
            let retryDelay = RATE_LIMIT_DELAY;
            if (retryAfter) {
              retryDelay = Math.max(retryDelay, parseInt(retryAfter) * 1000);
            }
            
            console.warn(`⚠️  Rate limited fetching form fields (attempt ${retryCount}/${MAX_RETRIES})`);
            console.warn(`   ⏰ Waiting 2 minutes (120 seconds) to reset quota...`);
            
            await sleep(retryDelay);
            
            if (retryCount < MAX_RETRIES) {
              console.log(`🔄 Retrying form fields fetch...`);
            }
          }
          // Handle validation errors (422 Unprocessable Entity) - wait once then retry
          else if (status === 422) {
            console.warn(`⚠️  Validation error fetching form fields`);
            console.warn(`   Status: 422 (Unprocessable Entity)`);
            console.warn(`   Error: ${err.response?.data?.error?.message || err.message}`);
            console.warn(`   ⏰ Waiting 2 minutes before retrying...`);
            
            await sleep(RATE_LIMIT_DELAY); // Wait 2 minutes
            
            console.log(`🔄 Retrying form fields fetch...`);
            // After 2-minute wait, retry once more (don't count as attempt)
          }
          // Handle server errors
          else if (status >= 500) {
            retryCount++;
            const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount - 1);
            
            console.warn(`⚠️  Server error ${status} fetching form fields (attempt ${retryCount}/${MAX_RETRIES})`);
            console.warn(`   Waiting ${(retryDelay / 1000).toFixed(1)} seconds before retry...`);
            
            await sleep(retryDelay);
            
            if (retryCount < MAX_RETRIES) {
              console.log(`🔄 Retrying form fields fetch...`);
            }
          }
          // Handle network errors
          else if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
            retryCount++;
            const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount - 1);
            
            console.warn(`⚠️  Network error: ${err.code} fetching form fields (attempt ${retryCount}/${MAX_RETRIES})`);
            console.warn(`   Waiting ${(retryDelay / 1000).toFixed(1)} seconds before retry...`);
            
            await sleep(retryDelay);
            
            if (retryCount < MAX_RETRIES) {
              console.log(`🔄 Retrying form fields fetch...`);
            }
          }
          // Other errors - don't retry
          else {
            console.error(`❌ Unrecoverable error fetching form fields:`, err.message);
            success = false;
            break;
          }
        }
      }
      
      if (!success && retryCount >= MAX_RETRIES) {
        console.error(`❌ Failed to fetch form fields after ${MAX_RETRIES} retries`);
        break;
      }
    }
    
    console.log(`✅ Total form fields fetched: ${totalFields}`);
    
    // Cache the results
    formFieldsCache = fieldsMap;
    return fieldsMap;
  } catch (err) {
    console.error(`❌ Error fetching form fields:`, err.message);
    return {};
  }
}

/**
 * Get field name by ID
 */
export function getFieldNameById(fieldId, fieldsMap) {
  if (!fieldsMap || !fieldsMap[fieldId]) {
    return `Unknown Field (${fieldId})`;
  }
  return fieldsMap[fieldId].title;
}

/**
 * Map ticket custom fields to human-readable format
 */
export function mapTicketCustomFields(ticket, fieldsMap) {
  if (!ticket.custom_fields || !Array.isArray(ticket.custom_fields)) {
    return {};
  }
  
  const mappedFields = {};
  
  for (const field of ticket.custom_fields) {
    const fieldId = field.id;
    const fieldValue = field.value;
    
    if (fieldValue === null || fieldValue === '') {
      continue; // Skip empty fields
    }
    
    const fieldInfo = fieldsMap[fieldId];
    if (fieldInfo) {
      mappedFields[fieldInfo.title] = {
        value: fieldValue,
        type: fieldInfo.type,
        key: fieldInfo.key,
        description: fieldInfo.description
      };
    } else {
      mappedFields[`Field_${fieldId}`] = {
        value: fieldValue,
        type: 'unknown',
        key: '',
        description: ''
      };
    }
  }
  
  return mappedFields;
}

/**
 * Fetch ticket comments with retry logic for rate limiting
 */
export async function fetchTicketComments(ticketId) {
  const zendeskClient = createZendeskClient();
  const MAX_RETRIES = 5;
  const INITIAL_RETRY_DELAY = 500; // Shorter delay for comments (less critical)
  const RATE_LIMIT_DELAY = 120000; // 2 minutes for 429 errors
  
  let retryCount = 0;
  let lastError = null;
  
  while (retryCount < MAX_RETRIES) {
    try {
      const response = await zendeskClient.get(`/tickets/${ticketId}/comments.json`);
      return response.data.comments || [];
      
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const retryAfter = err.response?.headers?.['retry-after'];
      
      // Handle rate limiting (429)
      if (status === 429) {
        retryCount++;
        
        // For 429 errors, wait 2 minutes (120 seconds) to reset quota
        let retryDelay = RATE_LIMIT_DELAY;
        if (retryAfter) {
          retryDelay = Math.max(retryDelay, parseInt(retryAfter) * 1000);
        }
        
        if (retryCount <= 1) { // Only log first attempt
          console.warn(`⚠️  Rate limited fetching comments for ticket ${ticketId}`);
          console.warn(`   ⏰ Waiting 2 minutes (120 seconds) to reset quota...`);
        }
        
        await sleep(retryDelay);
        continue;
      }
      // Handle server errors
      else if (status >= 500) {
        retryCount++;
        const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount - 1);
        
        if (retryCount <= 2) {
          console.warn(`⚠️  Server error ${status} fetching comments for ticket ${ticketId} (attempt ${retryCount}/${MAX_RETRIES})`);
        }
        
        await sleep(retryDelay);
        continue;
      }
      // Handle network errors
      else if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
        retryCount++;
        const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount - 1);
        
        if (retryCount <= 2) {
          console.warn(`⚠️  Network error: ${err.code} fetching comments for ticket ${ticketId} (attempt ${retryCount}/${MAX_RETRIES})`);
        }
        
        await sleep(retryDelay);
        continue;
      }
      // For other errors, return empty array (don't fail the entire import)
      else {
        console.error(`❌ Error fetching comments for ticket ${ticketId}:`, err.message);
        return [];
      }
    }
  }
  
  // If we exhausted retries
  console.error(`❌ Failed to fetch comments for ticket ${ticketId} after ${MAX_RETRIES} retries`);
  return [];
}

/**
 * Enrich ticket with comments and form fields
 */
export async function enrichTicketWithComments(ticket, fieldsMap = null) {
  const comments = await fetchTicketComments(ticket.id);
  
  const conversation = comments.map(comment => ({
    author: comment.author_id === ticket.requester_id ? 'Customer' : 'Agent',
    message: comment.plain_body || comment.body || '',
    created_at: comment.created_at,
    public: comment.public
  }));
  
  const agentComments = conversation.filter(c => c.author === 'Agent' && c.message.trim());
  const resolution = agentComments.length > 0 
    ? agentComments[agentComments.length - 1].message 
    : null;
  
  // Map custom fields if fieldsMap is provided
  const customFields = fieldsMap 
    ? mapTicketCustomFields(ticket, fieldsMap)
    : {};
  
  return {
    ticket_id: ticket.id,
    subject: ticket.subject || '',
    description: ticket.description || '',
    status: ticket.status,
    priority: ticket.priority,
    tags: ticket.tags || [],
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    conversation: conversation,
    resolution: resolution,
    custom_fields: customFields,
    requester_id: ticket.requester_id,
    assignee_id: ticket.assignee_id,
    brand_id: ticket.brand_id || null,
    brand: ticket.brand?.name || 'default'
  };
}

/**
 * Create custom object type for import logging
 */
export async function createCustomObjectType() {
  try {
    const zendeskClient = createZendeskClient();
    
    const objectKey = 'kb_import_log_v3';
    console.log(`🔧 Checking if custom object '${objectKey}' exists...`);
    
    try {
      const getResponse = await zendeskClient.get(`/custom_objects/${objectKey}`);
      console.log(`✅ Custom object '${objectKey}' already exists`);
    } catch (err) {
      if (err.response?.status !== 404) {
        throw err;
      }
      console.log(`📝 Custom object not found, creating new...`);
      
      await zendeskClient.post('/custom_objects', {
        custom_object: {
          key: objectKey,
          title: 'KB Import Records',
          title_pluralized: 'KB Import Records',
          description: 'Tracks knowledge base import history',
          raw_title: 'KB Import Records',
          raw_title_pluralized: 'KB Import Records',
          raw_description: 'Tracks knowledge base import history'
        }
      });
      
      console.log(`✅ Custom object created successfully`);
    }
    
    const fieldsToCreate = [
      { key: 'import_date', type: 'date', title: 'Import Date' },
      { key: 'start_date', type: 'date', title: 'Start Date' },
      { key: 'end_date', type: 'date', title: 'End Date' },
      { key: 'ticket_count', type: 'integer', title: 'Ticket Count' },
      { key: 'source', type: 'text', title: 'Source' }
    ];
    
    console.log(`🔧 Creating custom fields...`);
    for (const field of fieldsToCreate) {
      try {
        await zendeskClient.post(`/custom_objects/${objectKey}/fields`, {
          custom_object_field: {
            key: field.key,
            type: field.type,
            title: field.title,
            raw_title: field.title
          }
        });
        console.log(`   ✅ Created field: ${field.key}`);
      } catch (fieldErr) {
        if (fieldErr.response?.status === 422) {
          console.log(`   ℹ️  Field ${field.key} already exists`);
        } else {
          console.warn(`   ⚠️ Could not create field ${field.key}:`, fieldErr.response?.data?.error || fieldErr.message);
        }
      }
    }
    
    return true;
  } catch (err) {
    console.warn(`⚠️ Could not create custom object:`, err.message);
    return false;
  }
}

/**
 * Create custom object type for import errors
 */
export async function createErrorCustomObjectType() {
  try {
    const zendeskClient = createZendeskClient();
    
    const objectKey = 'kb_import_errors';
    console.log(`🔧 Checking if error custom object '${objectKey}' exists...`);
    
    try {
      const getResponse = await zendeskClient.get(`/custom_objects/${objectKey}`);
      console.log(`✅ Error custom object '${objectKey}' already exists`);
    } catch (err) {
      if (err.response?.status !== 404) {
        throw err;
      }
      console.log(`📝 Error custom object not found, creating new...`);
      
      await zendeskClient.post('/custom_objects', {
        custom_object: {
          key: objectKey,
          title: 'KB Import Errors',
          title_pluralized: 'KB Import Errors',
          description: 'Tracks knowledge base import errors',
          raw_title: 'KB Import Errors',
          raw_title_pluralized: 'KB Import Errors',
          raw_description: 'Tracks knowledge base import errors'
        }
      });
      
      console.log(`✅ Error custom object created successfully`);
    }
    
    const fieldsToCreate = [
      { key: 'error_date', type: 'date', title: 'Error Date' },
      { key: 'start_date', type: 'date', title: 'Start Date' },
      { key: 'end_date', type: 'date', title: 'End Date' },
      { key: 'error_message', type: 'text', title: 'Error Message' },
      { key: 'error_details', type: 'text', title: 'Error Details' },
      { key: 'source', type: 'text', title: 'Source' }
    ];
    
    console.log(`🔧 Creating error custom fields...`);
    for (const field of fieldsToCreate) {
      try {
        await zendeskClient.post(`/custom_objects/${objectKey}/fields`, {
          custom_object_field: {
            key: field.key,
            type: field.type,
            title: field.title,
            raw_title: field.title
          }
        });
        console.log(`   ✅ Created field: ${field.key}`);
      } catch (fieldErr) {
        if (fieldErr.response?.status === 422) {
          console.log(`   ℹ️  Field ${field.key} already exists`);
        } else {
          console.warn(`   ⚠️ Could not create field ${field.key}:`, fieldErr.response?.data?.error || fieldErr.message);
        }
      }
    }
    
    return true;
  } catch (err) {
    console.warn(`⚠️ Could not create error custom object:`, err.message);
    return false;
  }
}

/**
 * Create import record in Zendesk
 */
export async function createZendeskImportRecord(importData = {}) {
  try {
    const zendeskClient = createZendeskClient();
    const {
      startDate,
      endDate,
      ticketCount = 0,
      source = 'auto_import'
    } = importData;

    const today = new Date().toISOString().split('T')[0];
    const recordName = `Import ${today} | ${startDate} to ${endDate} | ${ticketCount} tickets | ${source}`;

    console.log(`📝 Creating import record in Zendesk...`);

    // Step 1: Create the record with just the name
    const recordPayload = {
      custom_object_record: {
        name: recordName
      }
    };

    const createResponse = await zendeskClient.post(
      '/custom_objects/kb_import_log_v3/records',
      recordPayload
    );

    const recordId = createResponse.data.custom_object_record?.id;
    console.log(`✅ Record created with ID: ${recordId}`);

    // Step 2: Update the record with custom field values
    const updatePayload = {
      custom_object_record: {
        custom_object_fields: {
          import_date: today,
          start_date: startDate,
          end_date: endDate,
          ticket_count: ticketCount,
          source: source
        }
      }
    };

    const updateResponse = await zendeskClient.patch(
      `/custom_objects/kb_import_log_v3/records/${recordId}`,
      updatePayload
    );

    console.log(`✅ Custom fields populated successfully`);
    return updateResponse.data.custom_object_record;

  } catch (err) {
    console.warn(`⚠️ Could not create import record:`, err.message);
    return null;
  }
}

/**
 * Create import record in Zendesk
 */
/**
 * Create error record in Zendesk
 */
export async function createZendeskErrorImportRecord(errorData = {}) {
  try {
    const zendeskClient = createZendeskClient();
    const {
      startDate = 'N/A',
      endDate = 'N/A',
      errorMessage = 'Unknown error',
      errorDetails = '',
      source = 'auto_import'
    } = errorData;

    const today = new Date().toISOString().split('T')[0];
    const recordName = `Error ${today} | ${startDate} to ${endDate} | ${errorMessage.substring(0, 50)}`;

    console.log(`📝 Creating error record in Zendesk...`);

    // Step 1: Create the record with just the name
    const recordPayload = {
      custom_object_record: {
        name: recordName
      }
    };

    const createResponse = await zendeskClient.post(
      '/custom_objects/kb_import_errors/records',
      recordPayload
    );

    const recordId = createResponse.data.custom_object_record?.id;
    console.log(`✅ Error record created with ID: ${recordId}`);

    // Step 2: Update the record with custom field values
    const updatePayload = {
      custom_object_record: {
        custom_object_fields: {
          error_date: today,
          start_date: startDate,
          end_date: endDate,
          error_message: errorMessage,
          error_details: errorDetails,
          source: source
        }
      }
    };

    const updateResponse = await zendeskClient.patch(
      `/custom_objects/kb_import_errors/records/${recordId}`,
      updatePayload
    );

    console.log(`✅ Error custom fields populated successfully`);
    return updateResponse.data.custom_object_record;

  } catch (err) {
    console.warn(`⚠️ Could not create error record:`, err.message);
    return null;
  }
}

/**
 * Get import records
 */
export async function getImportRecords(limit = 100) {
  try {
    const zendeskClient = createZendeskClient();
    
    const response = await zendeskClient.get(
      `/custom_object_records?custom_object_key=kb_import_log_v3&per_page=${limit}`
    );
    
    return response.data.custom_object_records || [];
  } catch (err) {
    console.warn(`⚠️ Could not fetch import records:`, err.message);
    return [];
  }
}

/**
 * Get error records
 */
export async function getErrorRecords(limit = 100) {
  try {
    const zendeskClient = createZendeskClient();
    
    const response = await zendeskClient.get(
      `/custom_object_records?custom_object_key=kb_import_errors&per_page=${limit}`
    );
    
    return response.data.custom_object_records || [];
  } catch (err) {
    console.warn(`⚠️ Could not fetch error records:`, err.message);
    return [];
  }
}