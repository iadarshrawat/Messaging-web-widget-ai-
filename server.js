import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createCustomObjectType } from "./src/config/zendesk.js";
import sunshineRoutes from "./src/routes/sunshine.route.js";

dotenv.config();

/* ================= APP SETUP ================= */

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

/* ================= ROUTES ================= */

// Sunshine routes (Chat widget functionality)
app.use(sunshineRoutes);


// Health check
app.get("/health", (_, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});


/* ================= SERVER STARTUP ================= */

async function startServer() {
  try {
    
    // Start listening immediately
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
      
      // Setup Zendesk custom object in background (with timeout)
      if (process.env.ZENDESK_EMAIL && process.env.ZENDESK_API_TOKEN && process.env.ZENDESK_DOMAIN) {
        Promise.race([
          createCustomObjectType(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
        ]).catch(err => {
          console.error("Zendesk setup error:", err.message);
        });
      }
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
