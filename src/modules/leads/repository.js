import { supabase } from "../../config/supabase.js";
import { LEAD_HEADERS } from "../../config/constants.js";
import crypto from "crypto";

export function generateId(prefix) {
  return \`\${prefix}_\${crypto.randomBytes(8).toString("hex")}\`;
}

export async function createDataset({ name, sourceFilename = null, uploadedBy = null, rowCount = 0, status = "active", notes = null }) {
  const { data, error } = await supabase
    .from("datasets")
    .insert({
      name,
      source_filename: sourceFilename,
      uploaded_by: uploadedBy,
      row_count: rowCount,
      status,
      notes,
    })
    .select("*")
    .single();

  if (error) {
    console.error("createDataset error:", error.message);
    throw error;
  }

  return data;
}

export async function readAllRows(datasetId = null) {
  let query = supabase.from("leads").select("*");

  if (datasetId === "initial") {
    query = query.is("dataset_id", null);
  } else if (datasetId) {
    query = query.eq("dataset_id", datasetId);
  }

  const { data, error } = await query.order("created_at", { ascending: true });

  if (error) {
    console.error("readAllRows error:", error.message);
    throw error;
  }

  const rows = (data || []).map(row => ({
    ...row,
    call_attempts: row.call_attempts ?? 0,
  }));

  return { headers: LEAD_HEADERS, rows };
}

export async function readRow(id) {
  let query = supabase.from("leads").select("*");

  if (typeof id === "string" && id.startsWith("lead_")) {
    query = query.eq("lead_id", id);
  } else {
    query = query.eq("id", id);
  }

  const { data, error } = await query.single();

  if (error) {
    console.error("readRow error:", error.message);
    throw error;
  }

  return data;
}

export async function updateRow(id, updates) {
  let query = supabase.from("leads");

  const cleanUpdates = { ...updates };
  delete cleanUpdates.id;
  delete cleanUpdates.created_at;

  if (typeof id === "string" && id.startsWith("lead_")) {
    query = query.update(cleanUpdates).eq("lead_id", id);
  } else {
    query = query.update(cleanUpdates).eq("id", id);
  }

  const { error } = await query;

  if (error) {
    console.error("updateRow error:", error.message);
    throw error;
  }
}

export async function appendRow(rowData) {
  const sourceRowNumber = rowData.source_row_number == null || rowData.source_row_number === ""
    ? null
    : parseInt(rowData.source_row_number, 10);

  const insertData = {
    ...rowData,
    lead_id: rowData.lead_id || generateId("lead"),
    property_id: rowData.property_id || generateId("prop"),
    call_status: rowData.call_status || "queued",
    call_attempts: parseInt(rowData.call_attempts, 10) || 0,
    dataset_id: rowData.dataset_id || null,
    source_row_number: Number.isFinite(sourceRowNumber) ? sourceRowNumber : null,
  };

  const { data, error } = await supabase
    .from("leads")
    .insert(insertData)
    .select()
    .single();

  if (error) {
    console.error("appendRow error:", error.message);
    throw error;
  }

  return { id: data.id, lead_id: data.lead_id, headers: LEAD_HEADERS };
}

export async function deleteRow(id) {
  let query = supabase.from("leads");

  if (typeof id === "string" && id.startsWith("lead_")) {
    query = query.delete().eq("lead_id", id);
  } else {
    query = query.delete().eq("id", id);
  }

  const { error } = await query;

  if (error) {
    console.error("deleteRow error:", error.message);
    throw error;
  }
}

export async function deleteRowsBulk(ids) {
  if (!ids || ids.length === 0) return;

  const { error } = await supabase
    .from("leads")
    .delete()
    .in("id", ids);

  if (error) {
    console.error("deleteRowsBulk error:", error.message);
    throw error;
  }
}

export async function updateRowsBulk(ids, updates) {
  if (!ids || ids.length === 0) return;

  const cleanUpdates = { ...updates };
  delete cleanUpdates.id;
  delete cleanUpdates.created_at;

  const { error } = await supabase
    .from("leads")
    .update(cleanUpdates)
    .in("id", ids);

  if (error) {
    console.error("updateRowsBulk error:", error.message);
    throw error;
  }
}

export async function deleteDatasetById(datasetId) {
  const trimmedId = String(datasetId || "").trim();
  if (!trimmedId) throw new Error("Missing dataset id");

  const { data: existingDataset, error: existingDatasetError } = await supabase
    .from("datasets")
    .select("id,name")
    .eq("id", trimmedId)
    .single();

  if (existingDatasetError) throw existingDatasetError;

  const { error: deleteLeadsError } = await supabase
    .from("leads")
    .delete()
    .eq("dataset_id", trimmedId);
  if (deleteLeadsError) throw deleteLeadsError;

  const { error: deleteDatasetError } = await supabase
    .from("datasets")
    .delete()
    .eq("id", trimmedId);
  if (deleteDatasetError) throw deleteDatasetError;

  return existingDataset;
}
