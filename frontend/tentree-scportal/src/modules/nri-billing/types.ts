// NRI billing — rate cards, the year's uploaded NRI invoice reports, and cost per
// GL by channel. Mirrors backend/src/controllers/nriBillingController.js.

export type Entity = 'CA' | 'US';

export type ContractRate = {
  id: string; entity: Entity; section: string | null; service: string | null; productGroup: string | null;
  uom: string | null; rate: number | null; rateText: string | null; currency: string | null;
  rateType: string | null; conditions: string | null; source: string | null; seq: number;
};

export type ContractTerm = {
  id: string; entity: Entity; kind: 'info' | 'rule'; code: string | null; label: string | null;
  value: string | null; detail: string | null; validationUse: string | null; source: string | null; seq: number;
};

export type RateCard = {
  entity: Entity;
  rates: ContractRate[];
  info: ContractTerm[];
  rules: ContractTerm[];
  serviceMap: { service: string; basis: string; codes: string[] }[];
};

export type BillingFile = {
  id: string; entity: Entity; fileName: string; invoiceNo: string | null;
  periodEnd: string | null; reportDate: string | null; lineCount: number;
  charges: number | null; taxes: number | null; invAmt: number | null;
  locked: boolean; uploadedAt: string; uploadedBy: string | null; hasOriginal: boolean;
  /** the upload's review (services → channel + GL confirmed); null = not reviewed */
  confirmedAt: string | null; confirmedBy: string | null;
};

export type Verdict =
  | 'ok' | 'overcharge' | 'undercharge' | 'qtyUnsupported' | 'tierBlend'
  | 'passthrough' | 'noContractRate' | 'noRateOnCard';

export type Bucket = 'verified' | 'flagged' | 'qtyUnsupported' | 'tierBlend' | 'passthrough' | 'notInAgreement';

export type BucketTotals = Record<Bucket, { lines: number; charges: number; variance: number }>;

export type RateCheck = {
  verdict: Verdict; expected: number | null; variance: number | null; rateCodes: string[];
  impliedHours?: number; impliedRate?: number; range?: [number, number];
};

export type Pivot = {
  classes: (string | null)[];
  rows: { gl: number | null; glDesc: string | null; lines: number; cells: Record<string, number>; total: number }[];
  totals: { cells: Record<string, number>; total: number; lines: number };
};

export type ServiceCheck = {
  service: string; lines: number; charges: number; units: number; variance: number; flagged: number;
  verdicts: Partial<Record<Verdict, number>>; rateCodes: string[];
  /** what the RATE CARD says the amount should be — never NRI's billed prices */
  calc: {
    /** one term per card line: priced (Σ quantity × rate), 'tier' (storage range), or 'text' (the card's words, no number) */
    terms: {
      code: string; basis: string; rate: number | null; rateMax?: number; uom: string | null; text?: string | null;
      fixed: number | null; fixedCode: string | null; lines: number; units: number; expected: number; min: number; max: number;
    }[];
    /** lines whose service is not on the card at all */
    offCard: { lines: number; units: number };
  };
};

export type DuplicatePair = { a: string; b: string; aName?: string; bName?: string; shared: number; share: number; charges: number };

export type Results = {
  entity: Entity;
  files: BillingFile[];
  selected: BillingFile[];
  totals: { lines: number; charges: number; taxes: number; invAmt: number };
  pivot: Pivot;
  rateCheck: { verdicts: Record<string, { lines: number; charges: number; variance: number }>; services: ServiceCheck[]; buckets: BucketTotals };
  classSources: Record<string, { lines: number; charges: number }>;
  flags: Record<string, number>;
  duplicates: DuplicatePair[];
  cardLoaded: boolean;
  orderDataRows: number;
  rules: { name: string; label: string }[];
  classes: string[];
  glOptions: { gl: number; glDesc: string | null }[];
};

export type CodedLine = {
  id: string; fileId: string; fileName?: string; seq: number;
  orderId: string | null; clientRef1: string | null; clientRef2: string | null; customer: string | null; poNumber: string | null;
  docDate: string | null; completed: string | null; units: number; value: number; service: string;
  charges: number; taxes: number; invAmt: number;
  netsuiteGl: number | null; description: string | null; defaultClass: string | null;
  classOverride: string | null; glOverride: number | null;
  revisedClass: string | null; revisedGl: number | null; revisedGlDesc: string | null;
  month: string | null; orderType: string | null; classSource: string; glSource: string;
  flags: string[]; rateCheck: RateCheck;
};

export type LinePage = { total: number; charges: number; page: number; pageSize: number; lines: CodedLine[] };

/** What the drill-down is showing — also exactly what a bulk override applies to. */
export type LineFilter = {
  gl?: string; cls?: string; service?: string; verdict?: Verdict; bucket?: Bucket; flag?: string; q?: string;
  /** 'manual' = lines whose GL someone set by hand */
  glSource?: 'manual' | 'rule' | 'wholesaleOrder' | 'legend' | 'unmapped';
};

/** Which files a view covers: specific ids, or a period-end month, or all. */
export type Scope = { entity: Entity; files?: string; month?: string };

export type UploadResult = {
  id: string; entity: Entity; fileName: string; invoiceNo: string | null; periodEnd: string | null;
  reportDate: string | null; lineCount: number; charges: number; taxes: number; invAmt: number;
  firstCompleted: string | null; lastCompleted: string | null;
  skipped: { repeatedHeader: number; blankService: number; footer: number };
  replaces: { id: string; fileName: string; lineCount: number } | null;
  overridesCarried: number; overridesDropped: number;
  duplicates: { fileId: string; fileName?: string; shared: number; share: number; charges: number }[];
  pivot: Pivot;
  rateCheck: { buckets: BucketTotals; services: ServiceCheck[] };
  flags: Record<string, number>;
  cardLoaded: boolean;
  /** whether the upload refreshed the order data from NetSuite first */
  orderData?: OrderSyncResult;
  dryRun?: boolean;
};

// ─── Channel rules (All Invoices → Rules) ────────────────────────────────────
export type RuleField = 'orderType' | 'service' | 'clientRef1' | 'clientRef2' | 'customer';
export type RuleOp = 'is' | 'startsWith' | 'contains';
export type RuleCondition = { field: RuleField; op: RuleOp; values: string[] };
export type RuleImpact = { lines: number; charges: number; changes: number; changedCharges: number };

export type RuleKind = 'orderType' | 'custom' | 'serviceColumn';

export type ClassRule = {
  id?: string;
  kind: RuleKind;
  name: string;
  enabled: boolean;
  conditions: RuleCondition[];
  setClass: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
  /** lines it codes now — files not Booked, no manual coding */
  live?: RuleImpact;
  /** lines it would code if every file were open — the impact preview */
  ifOpen?: RuleImpact;
};

export type RulesPayload = {
  entity: Entity;
  fields: RuleField[];
  ops: RuleOp[];
  files: { total: number; booked: number };
  classes: string[];
  suggestions: { orderType: string[]; service: string[] };
  rules: ClassRule[];
  /** one card per NRI service, for the two columns */
  services: ServiceCard[];
  /** every section is by invoice period-end month, each carrying forward on its own */
  monthInfo: {
    month: string;
    sections: Record<RuleKind, { source: 'own' | 'inherited' | 'base'; inheritedFrom: string | null }>;
    months: { month: string; files: number; booked: number; saved: boolean }[];
  };
};

export type ServiceCard = {
  service: string;
  /** the coding legend's channel for this service — where it sits until placed (null = not in the legend) */
  defaultClass: string | null;
};

// ─── Order data (the Order Type lookup), pulled from NetSuite ────────────────
export type OrderDataStatus = {
  entity: Entity;
  orders: number;
  fromNetsuite: number;
  fromFile: number;
  /** the pull is complete through this date */
  syncedThrough: string | null;
  lastSync: { at: string; by: string | null; from: string; to: string; fetched: number; added: number; updated: number } | null;
  latestFulfilment: string | null;
  locationPrefix: string | null;
};

export type OrderSyncResult = {
  ran?: boolean;
  error?: string;
  from?: string; to?: string;
  fetched?: number; added?: number; updated?: number;
  newTypes?: { type: string; channel: string; orders: number }[];
  syncedThrough?: string;
  seconds?: number;
  fulfilments?: { fetched: number; added: number; updated: number };
  returns?: { fetched: number; added: number; updated: number };
  /** records an invoice quoted (RA · IF · sales order · PO) that were fetched by reference */
  refsResolved?: {
    asked: number; fetched: number; added: number;
    byKind?: Partial<Record<'returns' | 'fulfilments' | 'salesOrders' | 'purchaseOrders', { fetched: number; added: number; updated: number }>>;
    newTypes?: { type: string; channel: string; orders: number }[];
  };
};

// ─── GL Codes (service → GL, by period-end month) ────────────────────────────
export type GlCodeRow = {
  service: string;
  /** the coding legend's GL — what Booked files are coded by (null = not in the legend) */
  legendGl: number | null;
  legendDesc: string | null;
  /** the GL in force for the selected month (null = no GL at all) */
  gl: number | null;
  /** the GL its lines take on a WHOLESALE ORDER, where it differs (null = same as gl) */
  glWholesaleOrder: number | null;
  /** lines billed in the month's files */
  lines: number;
  /** of those, lines the team recoded by hand to another GL, and to which */
  handRecoded: number;
  handTo: Record<string, number>;
};

export type GlCodesPayload = {
  entity: Entity;
  month: string;
  months: { month: string; files: number; booked: number; saved: boolean }[];
  /** where the month's GLs come from */
  source: 'own' | 'inherited' | 'legend';
  inheritedFrom: string | null;
  savedAt: string | null;
  savedBy: string | null;
  /** the month's invoice files — `ids` is what a link to Cost per GL scopes by */
  files: { total: number; booked: number; names: string[]; ids: string[] };
  glOptions: { gl: number; glDesc: string | null }[];
  services: GlCodeRow[];
};

// ─── Review after upload ─────────────────────────────────────────────────────
export type ReviewService = {
  service: string;
  lines: number;
  charges: number;
  /** lines decided by order type (step 1) or an exception — the channel below does not touch them */
  byOrder: number;
  channel: 'whsle' | 'online';
  /** where the channel hint comes from: own | from:YYYY-MM | starting | legend */
  channelHint: string;
  gl: number | null;
  /** where the GL hint comes from: own | from:YYYY-MM | legend | none */
  glHint: string;
  legendGl: number | null;
  /** Client Ref 1s behind the row (top 5 by charges) — the toggle-decided lines' when there are any */
  references: string[];
  referenceCount: number;
  /** why a person should look — empty = decided, folded away in the popup */
  check: ('noGl' | 'channelVaries' | 'channelNew' | 'glVaries')[];
  /** how the team set it in the months that saved their own settings, oldest first */
  channelHistory: { from: string; to: string; value: 'whsle' | 'online' }[];
  glHistory: { from: string; to: string; value: number }[];
};

/**
 * Lines the portal is NOT SURE about, one question per order / reference. The answer
 * is a hand coding on exactly those lines (never a month setting).
 *   channel — the line quotes an order the portal cannot find a type for
 *   gl      — a wholesale line of a service with a wholesale-order GL, no order behind it
 */
export type ReviewQuestion = {
  key: string;
  kind: 'channel' | 'gl';
  ref: string;
  why: 'orderNotFound' | 'orderNoType' | 'glWholesaleAsk';
  clientRef2: string | null;
  customer: string | null;
  services: string[];
  lineIds: string[];
  lines: number;
  charges: number;
  /** what the portal used meanwhile */
  channel: 'whsle' | 'online';
  gl: number | null;
  /** gl questions: the wholesale-order GL (the other answer is `gl`) */
  glWholesaleOrder: number | null;
};

export type FileReview = {
  file: BillingFile;
  month: string;
  locked: boolean;
  services: ReviewService[];
  questions: ReviewQuestion[];
  glOptions: { gl: number; glDesc: string | null }[];
};
