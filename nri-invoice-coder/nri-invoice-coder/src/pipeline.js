// Main entry for scripts AND for importing into the portal (Next.js API route, cron job, etc.)
import fs from 'node:fs';
import { readInvoiceFolder, readTable, readCsv } from './io.js';
import { buildCoder, isJunkRow } from './coder.js';
import * as R from './reports.js';

export async function loadConfig({ codingFile, rulesFile, ratesFile, ordersFile, overridesFile, lockedFile }) {
  const coding = JSON.parse(fs.readFileSync(codingFile, 'utf8'));
  const rules = rulesFile && fs.existsSync(rulesFile) ? JSON.parse(fs.readFileSync(rulesFile, 'utf8')) : [];
  const contractRates = ratesFile && fs.existsSync(ratesFile) ? JSON.parse(fs.readFileSync(ratesFile, 'utf8')) : null;
  const orders = ordersFile && fs.existsSync(ordersFile) ? await readTable(ordersFile) : [];
  const overrides = overridesFile && fs.existsSync(overridesFile) ? readCsv(overridesFile) : [];
  const lockedSources = lockedFile && fs.existsSync(lockedFile) ? JSON.parse(fs.readFileSync(lockedFile, 'utf8')) : [];
  return { coding, rules, contractRates, orders, overrides, lockedSources };
}

// rawRows: [{ 'Source.Name', OrderID, 'Client Ref 1', ..., Service, Charges, Taxes, 'Inv. Amt' }]
export function codeInvoices(rawRows, cfg, { source } = {}) {
  const codeLine = buildCoder(cfg);
  let lines = rawRows.filter((r) => !isJunkRow(r)).map(codeLine);
  if (source) lines = lines.filter((l) => l.source === source);
  return lines;
}

export function buildReports(lines, cfg) {
  return {
    glByClass: R.glByClass(lines),
    serviceByInvoice: R.serviceByInvoice(lines),
    glByServiceInvAmt: R.glByServiceInvAmt(lines),
    monthly: R.monthlyUnitRates(lines),
    contract: cfg.contractRates ? R.contractUnitRates(cfg.contractRates) : null,
    exceptions: R.exceptions(lines),
  };
}

export async function run(opts) {
  const cfg = await loadConfig(opts);
  const { files, rows } = readInvoiceFolder(opts.invoicesDir);
  const lines = codeInvoices(rows, cfg, { source: opts.source });
  return { files, cfg, lines, reports: buildReports(lines, cfg) };
}
