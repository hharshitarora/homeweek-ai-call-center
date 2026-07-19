import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { 
  findLeadByBolnaExecutionId, 
  findLikelyActiveBolnaLeadByPhone, 
  upsertBolnaCallTracking 
} from "../modules/voice/tracker.js";
import { sendWhatsAppHotLeadAlert } from "../modules/voice/notifications.js";

const router = express.Router();

router.post("/trigger-call", requireAuth, async (req, res) => {
  res.json({ ok: true, message: "Call triggered" });
});

router.post("/webhooks/bolna", async (req, res) => {
  const payload = req.body;
  const executionId = payload.execution_id;
  
  const lead = await findLeadByBolnaExecutionId(executionId);
  
  if (payload.outcome === "hot_lead") {
    await sendWhatsAppHotLeadAlert({
      leadName: lead?.lead_name,
      phoneE164: lead?.phone_e164,
      propertyName: lead?.property_name,
      callSummary: payload.summary
    });
  }
  
  res.json({ ok: true });
});

export default router;
