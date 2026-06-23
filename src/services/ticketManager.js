/**
 * Zendesk Ticket Manager
 * Handles ticket creation, routing, and agent assignment
 */

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

/**
 * Get Zendesk API client
 */
function getZendeskClient() {
  if (!process.env.ZENDESK_DOMAIN || !process.env.ZENDESK_EMAIL || !process.env.ZENDESK_API_TOKEN) {
    throw new Error("Zendesk credentials not configured");
  }

  const basicAuth = Buffer.from(
    `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
  ).toString("base64");

  return axios.create({
    baseURL: `https://${process.env.ZENDESK_DOMAIN}.zendesk.com/api/v2`,
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json"
    }
  });
}


/**
 * Get ticket by ID
 */
export async function getTicket(ticketId) {
  try {
    const client = getZendeskClient();
    const response = await client.get(`/tickets/${ticketId}`);
    return response.data.ticket;
  } catch (err) {
    console.error("Failed to fetch ticket:", err.message);
    throw err;
  }
}

/**
 * Create or find a user (requester) by email and update ticket
 * @param {number} ticketId - Zendesk ticket ID
 * @param {string} email - Customer email address
 * @param {string} name - Customer name
 */
export async function updateTicketRequester(ticketId, email, name) {
  if (!email || !ticketId) {
    throw new Error("Missing email or ticketId");
  }

  const client = getZendeskClient();

  // Step 1: Get the current requester ID from the ticket (often an anonymous temporary user)
  const ticketResponse = await client.get(`/tickets/${ticketId}.json`);
  const currentRequesterId = ticketResponse.data.ticket.requester_id;
  console.log(`📋 Current requester ID for ticket ${ticketId}: ${currentRequesterId}`);

  // Defensive: if no requester found, create or find a user by email and set it on the ticket
  if (!currentRequesterId) {
    console.log(`ℹ️ No requester on ticket ${ticketId}, searching/creating user for ${email}`);
    // Try to find existing user by email
      const { requestWithRetries } = await import('../utils/httpRetry.js');
      const searchRes = await requestWithRetries(() => client.get(`/users/search.json?query=${encodeURIComponent("email:" + email)}`), { retries: 3, initialDelay: 500 });
    const existingUser = searchRes.data.users?.[0];

    let userIdToUse;
    if (existingUser) {
      userIdToUse = existingUser.id;
      console.log(`✅ Found existing user ${userIdToUse} for email ${email}`);
    } else {
      const createRes = await client.post(`/users.json`, { user: { email, name: name || 'Customer', verified: true } });
      userIdToUse = createRes.data.user.id;
      console.log(`✅ Created new user ${userIdToUse} for email ${email}`);
    }

    await client.put(`/tickets/${ticketId}.json`, { ticket: { requester_id: userIdToUse } });
    console.log(`✅ Set ticket ${ticketId} requester to ${userIdToUse}`);
    return;
  }

  // Step 2: Update name on the current requester (best-effort)
  try {
    await client.put(`/users/${currentRequesterId}.json`, { user: { name: name || 'Customer' } });
    console.log(`✅ Updated name for user ${currentRequesterId}`);
  } catch (nameErr) {
    console.warn(`⚠️ Could not update name for user ${currentRequesterId}: ${nameErr.message}`);
  }

  // Step 3: Try to add the email as an identity to the current requester
  try {
    await client.post(`/users/${currentRequesterId}/identities.json`, {
      identity: {
        type: 'email',
        value: email,
        skip_verify_email: true,
        primary: true,
      }
    });

    console.log(`✅ Added email identity ${email} to user ${currentRequesterId}`);

    // Ensure the ticket points at this requester (it should already), but enforce it
    await client.put(`/tickets/${ticketId}.json`, { ticket: { requester_id: currentRequesterId } });
    console.log(`✅ Ensured ticket ${ticketId} requester is ${currentRequesterId}`);
    return;
  } catch (err) {
    const status = err.response?.status;
    // If email already exists on another user, merge current requester INTO the existing user
    if (status === 422) {
      console.warn(`⚠️ Email ${email} already exists on another Zendesk user — attempting merge flow`);
      try {
        const searchRes = await client.get(`/users/search.json?query=${encodeURIComponent("email:" + email)}`);
        const existingUser = searchRes.data.users?.[0];

        if (existingUser && existingUser.id !== currentRequesterId) {
          console.log(`🔀 Merging user ${currentRequesterId} into existing user ${existingUser.id}`);
            await requestWithRetries(() => client.put(`/users/${existingUser.id}/merge.json`, { user: { id: currentRequesterId } }), { retries: 3, initialDelay: 500 });

          // After merge, ensure ticket requester is set to the existing user's id
          await client.put(`/tickets/${ticketId}.json`, { ticket: { requester_id: existingUser.id } });
          console.log(`✅ Merged and set ticket ${ticketId} requester to ${existingUser.id}`);
          return;
        } else if (existingUser && existingUser.id === currentRequesterId) {
          // Strange but possible: same user found — update name
          await client.put(`/users/${currentRequesterId}.json`, { user: { name: name || 'Customer' } });
          console.log(`✅ Existing user matches requester; updated name`);
          return;
        } else {
          console.error(`❌ No existing user found to merge with for email ${email}`);
        }
      } catch (mergeErr) {
        console.error(`❌ Merge flow failed:`, mergeErr.response?.data || mergeErr.message);
        throw mergeErr;
      }
    }

    // Re-throw unexpected errors
    console.error(`❌ Failed to add identity for user ${currentRequesterId}:`, err.response?.data || err.message);
    throw err;
  }
}

