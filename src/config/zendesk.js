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