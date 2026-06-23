import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import sunshineRoutes from "./src/routes/sunshine.route.js";
import { runReport } from "./src/controllers/report.js";
import { connectDB } from "./src/config/mongo.js";

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

      // connect with mongoDB?
      connectDB();

      // Setup CSAT Report Cron Job (runs every 1 minute)
      console.log("🕐 Setting up CSAT Report cron job (every 1 minute)...");
      let reportRunning = false;

      setInterval(async () => {
        if (reportRunning) {
          console.log("⏭️  Skipping CSAT report (previous run still in progress)");
          return;
        }

        reportRunning = true;
        try {
          console.log(`\n📅 [${new Date().toISOString()}] Starting CSAT report run...`);
          const result = await runReport();
          
          if (result.success) {
            console.log(`✅ CSAT report completed successfully`);
            if (result.summary) {
              console.log(`   📊 Processed ${result.summary.total_tickets} tickets, CSAT: ${result.summary.csat_percent}%`);
            }
          } else {
            console.error(`❌ CSAT report failed: ${result.error}`);
          }
        } catch (err) {
          console.error(`❌ Unexpected error in CSAT report: ${err.message}`);
        } finally {
          reportRunning = false;
        }
      }, 60000); // 60000 ms = 1 minute

      console.log("✅ CSAT Report cron job started");
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
