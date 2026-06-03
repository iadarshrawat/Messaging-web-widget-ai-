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

