import express from "express";
import multer from "multer";
import { 
  readAllRows, 
  readRow, 
  updateRow, 
  appendRow, 
  deleteRow, 
  deleteRowsBulk, 
  updateRowsBulk,
  createDataset
} from "../modules/leads/repository.js";
import { parseLeadsCsv } from "../modules/leads/parser.js";
import { requireAuth } from "../middleware/auth.js";
import { LEAD_HEADERS } from "../config/constants.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(requireAuth);

router.get("/headers", async (req, res) => {
  res.json({ ok: true, headers: LEAD_HEADERS });
});

router.get("/rows", async (req, res) => {
  try {
    const datasetId = req.query.datasetId;
    const data = await readAllRows(datasetId);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/add-row", async (req, res) => {
  try {
    const result = await appendRow(req.body);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.put("/update-row", async (req, res) => {
  try {
    const { id, ...updates } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
    await updateRow(id, updates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.put("/update-rows-bulk", async (req, res) => {
  try {
    const { ids, updates } = req.body;
    if (!ids || !updates) return res.status(400).json({ ok: false, error: "Missing ids or updates" });
    await updateRowsBulk(ids, updates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete("/delete-row", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
    await deleteRow(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete("/delete-rows-bulk", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids) return res.status(400).json({ ok: false, error: "Missing ids" });
    await deleteRowsBulk(ids);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/upload-csv", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });
    
    const records = parseLeadsCsv(req.file.buffer);
    const datasetName = req.body.name || \`Upload \${new Date().toISOString()}\`;
    
    const dataset = await createDataset({
      name: datasetName,
      sourceFilename: req.file.originalname,
      rowCount: records.length,
      uploadedBy: req.user === "api-key" ? "api" : req.user
    });

    for (let i = 0; i < records.length; i++) {
      await appendRow({
        ...records[i],
        dataset_id: dataset.id,
        source_row_number: i + 1
      });
    }

    res.json({ ok: true, datasetId: dataset.id, rowCount: records.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
