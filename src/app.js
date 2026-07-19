import express from "express";
import cors from "cors";
import "dotenv/config";

import leadRoutes from "./api/leads.js";
import voiceRoutes from "./api/voice.js";

const app = express();

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

app.use(express.json({ limit: "5mb" }));

app.use("/", leadRoutes);
app.use("/", voiceRoutes);

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`🚀 Server running on port \${PORT}\`);
});

export default app;
