import express from "express";
import {
  handleSunshineMessage,
} from "../controllers/sunshine.js";
import { generateZendeskJWT } from "../controllers/widget_auth.js";
import { generateReport } from "../controllers/navbarReport.js";

const router = express.Router();

/**
 * Sunshine Conversations Routes
 * Handles chatbot integration through Zendesk Sunshine API
 */

// Incoming webhook from Zendesk Sunshine (customer messages)
router.post("/sunshine/webhook", handleSunshineMessage);


router.post("/sunshine/auth", generateZendeskJWT);


router.get("/sunshine/report", generateReport);


export default router;
