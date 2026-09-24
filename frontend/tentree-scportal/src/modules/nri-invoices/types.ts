// NRI 3PL invoice verification — types.
//
// The screen answers one question three ways:
//   INVOICE (the PDF)      is the SUMMARY   -> does the detail add up to the bill?
//   DATA (the xlsx)        is the SOURCE    -> what are we coding?
//   AGREEMENT (rate card)  is the VALIDATOR -> is each line priced correctly?

export type Verdict =
  | 'ok' | 'overcharge' | 'undercharge' | 'duplicate'
  | 'noRateOnFile' | 'noContractRate' | 'qtyUnsupported' | 'agingPremium';

export type CodingStatus = 'coded' | 'needsCoding' | 'needsClass';
export type TieOutStatus = 'balanced' | 'outOfBalance' | 'noSummary';
export type Severity = 'blocker' | 'warning' | 'info';

export type TieOutService = {
  service: string;
  lines: number;
  charges: number;
  taxes: number;
  invoiceAmount: number | null;
  variance: number | null;
  status: 'ok' | 'variance' | 'notOnInvoice' | 'missingFromDetail' | 'unproven';
};

export type TieOut = {
  status: TieOutStatus;
  message: string;
  detailCharges: number;
  detailTaxes: number;
  detailTotal: number;
  invoiceSubtotal?: number | null;
  invoiceTaxes?: number | null;
  invoiceTotal?: number | null;
  subtotalVariance?: number | null;
  taxVariance?: number | null;
  totalVariance?: number | null;
  services: TieOutService[];
  mismatched: number;
  unmatchedOnInvoice: string[];
};

export type InvoiceHeader = {
  invoiceNo: string | null;
  invoiceDate: string | null;
  endingDate: string | null;
  paymentTerms: string | null;
  dueDate: string | null;
  fxRate: number | null;
  subtotal: number | null;
  taxes: number | null;
  total: number | null;
  taxLines: { label: string; amount: number }[];
  isCredit: boolean;
};

export type InvoiceLine = {
  seq: number;
  invoiceNo?: string;
  sourceName: string | null;
  order: string | null;
  clientRef1: string | null;
  clientRef2: string | null;
  customer: string | null;
  poNumber: string | null;
  docDate: string | null;
  completed: string | null;
  month: string | null;
  units: number | null;
  value: number | null;
  service: string | null;
  charges: number;
  taxes: number;
  invAmt: number;

  // coding
  gl: number | null;
  glDesc: string | null;
  class: string | null;
  classBasis: string | null;
  classConfidence: string | null;
  orderType: string | null;
  legendClass: string | null;
  legendNote: string | null;
  codingStatus: CodingStatus;
  codingReason: string | null;
  overrideNote?: string | null;
  overriddenBy?: string | null;

  // validation against the agreement
  verdict: Verdict;
  expected: number | null;
  variance: number | null;
  rate: number | null;
  basis: string | null;
  checkDetail: string | null;
  impliedHours: number | null;
  effectiveRate: number | null;
  agingMultiple: number | null;
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
  maxAgingMultiple?: number;
  premium?: number;
  impliedHours?: number;
};

export type GlBucket = {
  gl: number | null;
  glDesc: string | null;
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
  needsAttention: number;
  validatedOk: number;
  unvalidatable: number;
  variance: number;
};

export type Reconcile = {
  entity: string;
  invoice: InvoiceHeader | null;
  tieOut: TieOut;
  totals: Totals;
  byGl: GlBucket[];
  byService: ServiceBucket[];
  findings: Finding[];
  lines: InvoiceLine[];
  sourceFile?: string;
  hasSummary?: boolean;
};

export type LoadedInvoice = InvoiceHeader & {
  id: string;
  invoiceNo: string;
  entity: string;
  sourceFile: string;
  hasSummary: boolean;
  invoiceNoSource: 'pdf' | 'manual';
  totals: Totals;
  status: 'loaded' | 'submitted';
  tieOutStatus: TieOutStatus | null;
  tieOutVariance: number | null;
  findingCount: number;
  blockerCount: number;
  loadedBy: string | null;
  loadedAt: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
};

export type InvoiceDetail = Omit<LoadedInvoice, 'tieOutStatus' | 'tieOutVariance' | 'findingCount' | 'blockerCount'> & {
  tieOut: TieOut;
  byGl: GlBucket[];
  byService: ServiceBucket[];
  findings: Finding[];
  lines: InvoiceLine[];
  overrideCount: number;
  posting?: { gl: number | null; glDesc: string | null; class: string; amount: number }[];
};

export type ChargeCode = {
  id: string;
  service: string;
  serviceRaw?: string;
  gl: number | null;
  glDesc: string | null;
  classUs: string | null;
  classCa: string | null;
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
  monthlyMinimum?: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
};

export type CostSummary = {
  entity: string;
  invoices: number;
  lines: number;
  total: number;
  byGl: { gl: number | null; glDesc: string | null; class: string; month: string | null; lines: number; amount: number }[];
  byMonth: { month: string; lines: number; amount: number }[];
  duplicateMonthlyFees: { service: string; month: string; count: number; amount: number; invoices: string[] }[];
  storageAging: {
    invoiceNo: string; month: string | null; units: number | null;
    charges: number; effectiveRate: number | null; agingMultiple: number | null; premium: number | null;
  }[];
  storagePremium: number;
};

/**
 * One invoicing WAREHOUSE = one tab under All Invoices.
 *
 * `parser` names the detail-file layout used to read that warehouse's workbook;
 * null means none is mapped, so `uploadEnabled` is false and the tab is a shell
 * (its invoice list, legend slice and rate card exist, but nothing can be
 * uploaded). Every 3PL builds its workbook differently — registering a warehouse
 * cannot invent a reader for a format nobody has seen.
 */
export type InvoiceSource = {
  code: string;            // URL segment: 'nri-us'
  label: string;           // 'NRI US'
  entity: string;          // the key the legend, rate card and invoice ids turn on: 'US'
  facilityId: string | null;
  parser: string | null;
  uploadEnabled: boolean;
  note: string | null;     // why uploads are off, shown on the tab's page
  invoiceCount?: number;
};
