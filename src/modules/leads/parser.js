import { parse } from "csv-parse/sync";

export function parseLeadsCsv(buffer) {
  try {
    const records = parse(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    return records;
  } catch (err) {
    console.error("parseLeadsCsv error:", err.message);
    throw new Error("Failed to parse CSV file");
  }
}

export function validateLeadData(record) {
  if (!record.phone_e164 && !record.phone) {
    throw new Error("Missing phone number in record");
  }
  return true;
}
