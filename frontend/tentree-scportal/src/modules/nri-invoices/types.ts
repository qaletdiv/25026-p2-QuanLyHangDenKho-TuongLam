// NRI 3PL invoice verification — types.
//
// The screen answers one question three ways:
//   INVOICE (the PDF)      is the SUMMARY   -> does the detail add up to the bill?
//   DATA (the xlsx)        is the SOURCE    -> what are we coding?
//   AGREEMENT (rate card)  is the VALIDATOR -> is each line priced correctly?

export type Verdict =
  | 'ok' | 'overcharge' | 'undercharge' | 'duplicate'
  | 'no_rate_on_file' | 'no_contract_rate' | 'qty_unsupported' | 'aging_premium';

export type CodingStatus = 'coded' | 'needs_coding' | 'needs_class';
export type TieOutStatus = 'balanced' | 'out_of_balance' | 'no_summary';
export type Severity = 'blocker' | 'warning' | 'info';

export type TieOutService = {
  service: string;
  lines: number;
  charges: number;
  taxes: number;
  invoice_amount: number | null;
  variance: number | null;
  status: 'ok' | 'variance' | 'not_on_invoice' | 'missing_from_detail' | 'unproven';
};

export type TieOut = {
  status: TieOutStatus;
  message: string;
  detail_charges: number;
  detail_taxes: number;
  detail_total: number;
  invoice_subtotal?: number | null;
  invoice_taxes?: number | null;
  invoice_total?: number | null;
  subtotal_variance?: number | null;
  tax_variance?: number | null;
  total_variance?: number | null;
  services: TieOutService[];
  mismatched: number;
  unmatched_on_invoice: string[];
};

export type InvoiceHeader = {
  invoice_no: string | null;
  invoice_date: string | null;
  ending_date: string | null;
  payment_terms: string | null;
  due_date: string | null;
  fx_rate: number | null;
  subtotal: number | null;
  taxes: number | null;
  total: number | null;
  tax_lines: { label: string; amount: number }[];
  is_credit: boolean;
};

export type InvoiceLine = {
  seq: number;
  invoice_no?: string;
  source_name: string | null;
  order: string | null;
  client_ref_1: string | null;
  client_ref_2: string | null;
  customer: string | null;
  po_number: string | null;
  doc_date: string | null;
  completed: string | null;
  month: string | null;
  units: number | null;
  value: number | null;
  service: string | null;
  charges: number;
  taxes: number;
  inv_amt: number;

  // coding
  gl: number | null;
  gl_desc: string | null;
  class: string | null;
  class_basis: string | null;
  class_confidence: string | null;
  order_type: string | null;
  legend_class: string | null;
  legend_note: string | null;
  coding_status: CodingStatus;
  coding_reason: string | null;
  override_note?: string | null;
  overridden_by?: string | null;

  // validation against the agreement
  verdict: Verdict;
  expected: number | null;
  variance: number | null;
  rate: number | null;
  basis: string | null;
  check_detail: string | null;
  implied_hours: number | null;
  effective_rate: number | null;
  aging_multiple: number | null;
};

export type Finding = {
  severity: Severity;
  type: string;
  title: string;
  lines: number;
  amount: number;
  variance: number;
  services: string[];
  examples: {
    seq?: number; service: string; month?: string | null; units?: number | null;
    charges?: number; expected?: number | null; detail: string | null;
  }[];
  max_aging_multiple?: number;
  premium?: number;
  implied_hours?: number;
};

export type GlBucket = {
  gl: number | null;
  gl_desc: string | null;
  lines: number;
  charges: number;
  taxes: number;
  amount: number;
  classes: { class: string; amount: number }[];
};

export type ServiceBucket = {
  service: string;
  gl: number | null;
  basis: string | null;
  lines: number;
  units: number;
  charges: number;
  amount: number;
  expected: number | null;
  variance: number | null;
  verdict: Verdict;
};

export type Totals = {
  lines: number;
  charges: number;
  taxes: number;
  amount: number;
  coded: number;
  needs_attention: number;
  validated_ok: number;
  unvalidatable: number;
  variance: number;
};

export type Reconcile = {
  entity: string;
  invoice: InvoiceHeader | null;
  tie_out: TieOut;
  totals: Totals;
  by_gl: GlBucket[];
  by_service: ServiceBucket[];
  findings: Finding[];
  lines: InvoiceLine[];
  source_file?: string;
  has_summary?: boolean;
};

export type LoadedInvoice = InvoiceHeader & {
  id: string;
  invoice_no: string;
  entity: string;
  source_file: string;
  has_summary: boolean;
  invoice_no_source: 'pdf' | 'manual';
  totals: Totals;
  status: 'loaded' | 'submitted';
  tie_out_status: TieOutStatus | null;
  tie_out_variance: number | null;
  finding_count: number;
  blocker_count: number;
  loaded_by: string | null;
  loaded_at: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
};

export type InvoiceDetail = Omit<LoadedInvoice, 'tie_out_status' | 'tie_out_variance' | 'finding_count' | 'blocker_count'> & {
  tie_out: TieOut;
  by_gl: GlBucket[];
  by_service: ServiceBucket[];
  findings: Finding[];
  lines: InvoiceLine[];
  override_count: number;
  posting?: { gl: number | null; gl_desc: string | null; class: string; amount: number }[];
};

export type ChargeCode = {
  id: string;
  service: string;
  service_raw?: string;
  gl: number | null;
  gl_desc: string | null;
  class_us: string | null;
  class_ca: string | null;
  note: string | null;
};

export type RateCardRow = {
  id: string;
  entity: string;
  service: string;
  basis: string;
  rate: number | null;
  fixed?: number;
  uom: string | null;
  tiers?: { label: string; rate: number; multiple: number }[];
  monthly_minimum?: number;
  effective_from: string;
  effective_to: string | null;
  source: string;
};

export type CostSummary = {
  entity: string;
  invoices: number;
  lines: number;
  total: number;
  by_gl: { gl: number | null; gl_desc: string | null; class: string; month: string | null; lines: number; amount: number }[];
  by_month: { month: string; lines: number; amount: number }[];
  duplicate_monthly_fees: { service: string; month: string; count: number; amount: number; invoices: string[] }[];
  storage_aging: {
    invoice_no: string; month: string | null; units: number | null;
    charges: number; effective_rate: number | null; aging_multiple: number | null; premium: number | null;
  }[];
  storage_premium: number;
};
