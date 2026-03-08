/**
 * Ingestion history — JSONL log of scheduler runs.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface HistoryEntry {
  timestamp: string;
  jobName: string;
  source: string;
  type: string;
  itemsIngested: number;
  errors: string[];
  durationMs: number;
}

const historyPath = path.join(config.dataDir, "ingest-history.jsonl");

export function appendHistory(entry: HistoryEntry): void {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, JSON.stringify(entry) + "\n");
}

export function readHistory(limit = 50): HistoryEntry[] {
  if (!fs.existsSync(historyPath)) return [];

  const lines = fs.readFileSync(historyPath, "utf-8").trim().split("\n").filter(Boolean);

  // Slice to last `limit` lines before JSON parsing to avoid processing the entire file
  const tail = lines.slice(-limit);
  const entries: HistoryEntry[] = [];

  // Reverse order so most recent comes first
  for (let i = tail.length - 1; i >= 0; i--) {
    try {
      entries.push(JSON.parse(tail[i]!));
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}
