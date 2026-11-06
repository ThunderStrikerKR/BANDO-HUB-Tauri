import type { Brand, RegistrationBatch, SourceLink } from "./product-registry.js";
import type { WorkflowState } from "./workflow-types.js";
export type Tier = "wholesale" | "semi" | "retail" | "special";
export type Origin = "STORE" | "FACTORY";
export type Price = number | null;
export type Catalog = "BANDOSTAND" | "BANDOMALL" | "DEMO";
export interface Variant {
  id: string;
  color: string;
  wholesale: Price;
  semi: Price;
  retail: Price;
  url: string;
  source: "DEMO" | "MANUAL" | "OFFICIAL";
  collectedAt?: string;
  option?: string;
  siteOptionId?: string;
  officialRetail?: Price;
  retailNote?: string;
  siteProductId?: string;
  legacyIds?: string[];
}
export interface Change {
  at: string;
  field: string;
  before: unknown;
  after: unknown;
  source: string;
}
export interface Product {
  imageData?: string;
  imageSource?: string;
  imageOverride?: "MANUAL" | "HIDDEN";
  brandId?: string;
  manufacturerCode?: string;
  specification?: string;
  sellingUnit?: string;
  registrationIdentity?: string;
  verificationStatus?: string;
  saleUnit?: boolean;
  familyKey?: string;
  isDefaultSale?: boolean;
  sourceProductId?: string;
  colorStatus?: "KNOWN" | "NOT_REQUIRED" | "MISSING";
  id: string;
  code: string;
  name: string;
  category: string;
  origin: Origin;
  defaultColor: string;
  active: boolean;
  variants: Variant[];
  createdAt: string;
  updatedAt: string;
  catalog?: Catalog;
  siteId?: string;
  siteCode?: string;
  modelCodes?: string[];
  categories?: string[];
  saleStatus?: string;
  priceHistory?: Change[];
  baseRetail?: Price;
  requiresOption?: boolean;
  subtitle?: string;
  originalName?: string;
  originalCode?: string;
  siteRefs?: string[];
  shippingGroupId?: string;
  deletedAt?: string;
  supersededBy?: string;
  modelKey?: string;
  dataIssues?: string[];
}
export interface Client {
  postcode?: string;
  defaultApplyVat?: boolean;
  id: string;
  name: string;
  contact: string;
  tier: Tier;
  shippingFeeExcluded: boolean;
  payment: "PREPAID" | "POSTPAID";
  active: boolean;
  identifiers: string;
  overrides: Record<string, number>;
  displayName?: string;
  address?: string;
  phone?: string;
  mobile?: string;
  person?: string;
  shortNames?: string;
  preferredAccountId?: string; // 거래처별 우선 안내 계좌, 미지정 시 상품 추천 계좌
  history?: Change[];
  deletedAt?: string;
}
export interface Alias {
  createdAt?: string;
  actor?: string;
  id: string;
  clientId: string | null;
  text: string;
  productId: string;
  variantId?: string;
}
export interface SourceSpan {
  recipientId?: string;
  start: number;
  end: number;
  field: string;
  targetId: string;
  text: string;
}
export interface Candidate {
  id: string;
  field: string;
  value: string;
  label: string;
  start: number;
  end: number;
  productId?: string;
  variantId?: string;
}
export interface Item {
  selectionEvidence?: { expression: string; productId: string; variantId: string };
  pendingAlias?: Alias;
  match?: {
    kind: MatchKind;
    term: string;
    productIds: string[];
    aliasId?: string;
  };
  quantityApproval?: { at: string; actor: string; quantity: number };
  temporary?: boolean;
  recognitionReason?: string;
  modelProposal?: { original: string; required: boolean };
  manuallyConfirmed?: boolean;
  quantityConfirmed?: boolean;
  productCandidates?: Candidate[];
  sources?: SourceSpan[];
  id: string;
  productId: string | null;
  variantId: string | null;
  raw: string;
  name: string;
  color: string;
  quantity: number | null;
  unitPrice: Price;
  origin: Origin;
  defaulted: boolean;
  issues: string[];
  url: string;
  originalProductId?: string;
  originalVariantId?: string;
  originalModel?: string;
  catalog?: Catalog;
}
export interface AddressParts {
  province?: string;
  city?: string;
  district?: string;
  town?: string;
  road?: string;
  building?: string;
  detail?: string;
}
export interface Recipient {
  unassignedEvidence?: import("./order-evidence.js").OrderEvidence[];
  evidence?: { anchorId: string; start: number; end: number };
  dispatchOrigin?: Origin;
  actualFreight?: Price;
  freightCode?: "010" | "020";
  addressParts?: AddressParts;
  vatDefault?: boolean;
  vatOverride?: boolean;
  shippingCharges?: Partial<Record<Origin, Price>>;
  addressStatus?: "INCOMPLETE" | "COMPLETE" | "CONFIRMED";
  addressKind?: "ROAD" | "LOT" | "UNKNOWN";
  candidates?: Candidate[];
  sources?: SourceSpan[];
  confirmedFields?: string[];
  id: string;
  name: string;
  address: string;
  phone: string;
  mobile: string;
  note: string;
  items: Item[];
}
export type Status =
  | "RECEIVED"
  | "REVIEW"
  | "STATEMENT"
  | "NOTIFIED"
  | "WAITING"
  | "APPROVED"
  | "QUEUED"
  | "EXPORTED";
export type OrderType = "AGENCY" | "DEALER" | "RETAIL";
export interface Order {
  orderType?: OrderType;
  senderSnapshot?: Client;
  analysisEvidence?: import("./order-evidence.js").OrderEvidence[];
  receptionVersion?: 1;
  confirmedAt?: string;
  confirmationSnapshot?: {
    at: string;
    raw: string;
    client: Client;
    recipients: Recipient[];
    data?: Omit<Order, "confirmationSnapshot">;
  };
  analysisSnapshot?: { at: string; raw: string; ruleVersion: string; recipients: Recipient[] };
  manualClassification?: {
    blocks: (SourceSpan & { id: string })[];
    assignments: Record<
      string,
      { recipientId: string; itemId?: string; field: string; value: string }
    >;
  };
  receipt?: {
    original: string;
    at: string;
    actor: string;
    clientId: string;
    legacy: boolean;
  };
  rawCorrections?: {
    id: string;
    at: string;
    actor: string;
    reason: string;
    before: string;
    after: string;
    affectedRecipientIds: string[];
  }[];
  requestedIssueIds?: string[];
  messageNotes?: Record<string, { payment?: string; request?: string }>;
  requestMessages?: Record<string, string>;
  requestCopiedGroups?: string[];
  issueResolutions?: Record<string, IssueDecision>;
  additionalQuestions?: {
    id: string;
    itemId: string;
    recipientId: string;
    text: string;
  }[];
  deletedAt?: string;
  rawHistory?: { at: string; raw: string; actor: string }[];
  groupMessageEdits?: Record<string, { payment?: string; options?: string }>;
  groupAccounts?: Record<string, { mode: "AUTO" | "MANUAL"; id?: string }>;
  analysisRaw?: string;
  analysisClientId?: string;
  id: string;
  clientId: string;
  raw: string;
  channel: string;
  recipients: Recipient[];
  shippingFee: Price;
  applyVat: boolean;
  vatAmount: Price;
  status: Status;
  notified: boolean;
  paid: boolean;
  postpaidApproved: boolean;
  freightCode: "010" | "020";
  createdAt: string;
  updatedAt: string;
  photos?: string[];
  accountMode?: "AUTO" | "MANUAL";
  accountId?: string;
  pricesLocked?: boolean;
  clientSnapshot?: Client;
  shippingMode?: "AUTO" | "MANUAL";
  actualFreight?: Price;
  replies?: ReplyRecord[];
  messageEdits?: { payment?: string; options?: string };
  billingHistory?: BillingSnapshot[];
  shippingVersion?: string;
}
export interface BillingSnapshot {
  at: string;
  reason: string;
  recipients: Recipient[];
  shippingFee: Price;
  vatAmount: Price;
  applyVat: boolean;
  total: Price;
  status: Status;
  paid: boolean;
  notified: boolean;
  postpaidApproved: boolean;
  client: Client;
}
export interface ReplyChange {
  recipientId: string;
  itemId: string;
  before: Item;
  after: Item;
}
export interface RecipientReplyChange {
  recipientId: string;
  before: Pick<Recipient, "name" | "address" | "phone" | "mobile" | "note">;
  after: Pick<Recipient, "name" | "address" | "phone" | "mobile" | "note">;
}
export interface ReplyPreview {
  recipientChanges?: RecipientReplyChange[];
  raw: string;
  changes: ReplyChange[];
  warnings: string[];
  requiresReapproval: boolean;
}
export interface ReplyRecord {
  recipientChanges?: RecipientReplyChange[];
  id: string;
  at: string;
  raw: string;
  changes: ReplyChange[];
}
export interface ShippingRule {
  validFrom?: string;
  validUntil?: string;
  packable?: boolean | null;
  basis?: string;
  version: string;
  at: string;
  fees: Record<string, Price>;
  maxBundle: number | null;
  maxConfirmed: boolean;
  perItem: Price;
  notes: string;
}
export interface ShippingGroup {
  deletedAt?: string;
  id: string;
  name: string;
  current: ShippingRule;
  history: ShippingRule[];
}
export interface ShippingCombination {
  shipmentId?: string;
  verifiedAt?: string;
  sampleCount?: number;
  observedCharge?: number;
  id: string;
  key: string;
  epoch: number;
  versions: Record<string, string>;
  charge: number;
  actual: Price;
  at: string;
  active: boolean;
  description: string;
}
export interface FreightAdjustment {
  id: string;
  shipmentId: string;
  items: {
    productId: string | null;
    variantId: string | null;
    model: string;
    quantity: number | null;
    origin: Origin;
  }[];
  recommended: number;
  confirmed: number;
  actor: string;
  confirmedAt: string;
  ruleVersion: string;
}
export interface ShippingState {
  adjustments?: FreightAdjustment[];
  epoch: number;
  groups: ShippingGroup[];
  combinations: ShippingCombination[];
  productRules?: Record<string, ShippingRule>;
  productHistory?: Record<string, ShippingRule[]>;
}
export interface ShippingBundle {
  key: string;
  recipientId: string;
  origin: Origin;
  items: Item[];
  versions: Record<string, string>;
  description: string;
  recommendation: Price;
  reason: string;
  source: "COMBINATION" | "GROUP" | "MANUAL";
}
export interface Account {
  id: string;
  bank: string;
  number: string;
  holder: string;
}
export interface Settings {
  senderPostcode?: string;
  excelDirectory?: string;
  factoryReplyDirectory?: string;
  modelRepresentatives?: Record<string, { productId: string; variantId: string }>;
  modelFamilies?: Record<string, { code: string; productIds: string[] }>;
  kakaoTitleMappings?: Record<
    string,
    { clientId: string; updatedAt: string; actor: string; ambiguous?: boolean }
  >;
  kakaoTitleEnabled?: boolean;
  panelRatios?: number[];
  receptionVerticalRatio?: number;
  operatorName?: string;
  uiScale?: 90 | 100 | 110 | 125;
  accounts: Account[];
  defaultAccountId: string;
  senderName: string;
  senderAddress: string;
  senderPhone: string;
  senderMobile: string;
  rounding: "ROUND";
  brandAccounts?: { BANDOSTAND: string; BANDOMALL: string };
  specialPolicy?: "WHOLESALE_EXCEPTIONS" | "UNCONFIRMED";
}
export interface ExportRecord {
  savedPath?: string;
  snapshots?: import("./workflow-types.js").ExcelQueueEntry[];
  id: string;
  at: string;
  orderIds: string[];
  filename: string;
  queueEntryIds?: string[];
}
export interface Category {
  active?: boolean;
  id: string;
  name: string;
  parentId: string | null;
}
export interface State {
  brands?: Brand[];
  sourceLinks?: SourceLink[];
  registrationBatches?: RegistrationBatch[];
  revision?: number;
  workflow?: WorkflowState;
  products: Product[];
  clients: Client[];
  aliases: Alias[];
  orders: Order[];
  settings: Settings;
  queue: string[];
  exports: ExportRecord[];
  categories?: Category[];
  shipping?: ShippingState;
  deletedProductKeys?: string[];
  productMappings?: Record<string, string>;
  variantMappings?: Record<string, string>;
  factoryReplies?: import("./factory-replies.js").FactoryReply[];
}
export interface ImportPreview {
  product: Product;
  existingId: string | null;
  warnings: string[];
  sourceUrl: string;
  related?: Product[];
  canApply?: boolean;
  revision?: number;
}
export interface OfficialLink {
  name: string;
  url: string;
}
export interface InboxEntry {
  id: string;
  at: string;
  text: string;
  photo?: string;
}
export interface MobileStatus {
  running: boolean;
  urls: string[];
}
export interface CatalogReport {
  categories: {
    id: string;
    name: string;
    parentId: string | null;
    pages: number;
    ids: string[];
    errors: string[];
  }[];
  products: Product[];
  failures: {
    url?: string;
    productId?: string;
    category?: string;
    error: string;
  }[];
  collectedAt: string;
  sourceProductCount?: number;
}
export interface BulkPreview {
  kind: "prices" | "clients";
  changes: {
    id: string;
    label: string;
    before: string;
    after: string;
    warning?: string;
  }[];
  products?: Product[];
  clients?: Client[];
  errors: string[];
}
export interface DockWindow {
  kind?: "MAIN" | "CHAT";
  className?: string;
  handle: string;
  title: string;
  processId: number;
}
export interface DockStatus {
  notice?: string;
  mode?: "OVERLAP" | "STACK" | "ORIGINAL";
  active: boolean;
  ratio: number;
  handle?: string;
}
export interface StartupMetrics {
  windowShownMs: number;
  databaseMs: number;
  dataMs: number;
  readyMs: number;
}
export interface Api {
  saveProductWorkbook?: (bytes: number[]) => Promise<string | null>;
  saveProductSyncWorkbook?: (bytes: number[]) => Promise<string | null>;
  saveClientWorkbook?: (bytes: number[]) => Promise<string | null>;
  saveRegistrationWorkbook?: (kind: "양식" | "결과", bytes: number[]) => Promise<string | null>;
  openFactoryFile?: (id: string) => Promise<void>;
  productImage?: (id: string) => Promise<{ data: string; source: string } | null>;
  approveFactoryConflict?: (id: string, row: number) => Promise<void>;
  isTestWorkspace?: boolean;
  openTestWorkspace?: () => Promise<void>;
  testDatabasePreview?: () => Promise<
    | { enabled: false }
    | {
        enabled: true;
        revision: number;
        orders: number;
        clients: number;
        exports: number;
        shipments: number;
        payments: number;
        replies: number;
      }
  >;
  resetTestDatabase?: (revision: number) => Promise<{ backup: string }>;
  receiptArchive: () => Promise<{ id: string; orderId: string; record: Record<string, unknown> }[]>;
  captureReceipt: (id: string, text: string) => Promise<NonNullable<Order["receipt"]>>;
  recordReceiptCorrection: (
    id: string,
    record: NonNullable<Order["rawCorrections"]>[number],
  ) => Promise<void>;
  registrationTemplate: () => Promise<void>;
  registrationPreview: () => Promise<{
    fingerprint: string;
    rows: import("./product-registry.js").RegistrationRow[];
  } | null>;
  registrationCommit: (fingerprint: string) => Promise<{ created: number; skipped: number }>;
  registrationResults: () => Promise<void>;
  openProduct: (url: string) => Promise<void>;
  dockRegion: (region: { x: number; y: number; width: number; height: number }) => Promise<void>;
  requestClose: (hasUnsavedChanges: boolean) => Promise<void>;
  onLayoutReset?: (fn: () => void) => () => void;
  dockCycle: () => Promise<DockStatus>;
  windowControl: (action: "minimize" | "maximize" | "close") => Promise<void>;
  dockSelect: (handle: string) => Promise<DockStatus>;
  load: () => Promise<State>;
  save: (state: State) => Promise<void>;
  patchSettings?: (changes: Record<string, unknown>, expected: Record<string, unknown>) => Promise<State>;
  chooseExcelDirectory: () => Promise<string | undefined>;
  openExcelDirectory: () => Promise<void>;
  openExportFile: (id: string) => Promise<void>;
  exportExcel: (ids: string[]) => Promise<{ cancelled: boolean; filename?: string }>;
  previewImport: (url: string) => Promise<ImportPreview>;
  officialList: () => Promise<OfficialLink[]>;
  copy: (text: string) => Promise<void>;
  readClipboard: () => Promise<string>;
  mobileStart: () => Promise<MobileStatus>;
  mobileStop: () => Promise<MobileStatus>;
  mobileStatus: () => Promise<MobileStatus>;
  inbox: () => Promise<InboxEntry[]>;
  catalogReport: () => Promise<CatalogReport>;
  approveCatalog: () => Promise<{ updated: number; created: number }>;
  downloadSheet: (kind: "prices" | "clients") => Promise<void>;
  previewSheet: (kind: "prices" | "clients") => Promise<BulkPreview | null>;
  approveSheet: () => Promise<void>;
  backup: () => Promise<string>;
  backups: () => Promise<string[]>;
  restore: (filename: string) => Promise<void>;
  setPrice: (
    productId: string,
    variantId: string,
    tier: "wholesale" | "semi" | "retail",
    price: Price,
    expected: Price,
  ) => Promise<State>;
  dockWindows: () => Promise<DockWindow[]>;
  dockStart: (handle: string, ratio: number) => Promise<DockStatus>;
  dockStop: () => Promise<DockStatus>;
  dockStatus: () => Promise<DockStatus>;
  startupMetrics: () => Promise<StartupMetrics>;
  retryStartup: () => Promise<void>;
}
declare global {
  interface Window {
    bando?: Api;
  }
}

export type MatchKind =
  | "CODE"
  | "CLIENT_ALIAS"
  | "COMMON_ALIAS"
  | "COMMON_INHERIT"
  | "CATEGORY"
  | "CONFLICT"
  | "CATEGORY_CONFLICT"
  | "UNKNOWN"
  | "QUANTITY";
export type IssueResolution =
  | "UNRESOLVED"
  | "PENDING_CUSTOMER"
  | "PROVISIONALLY_APPROVED"
  | "RESOLVED"
  | "AUTO_APPLIED";
export interface IssueDecision {
  resolution: IssueResolution;
  resolutionSource: string;
  updatedAt: string;
  evidence: string;
}
export interface ValidationIssue {
  evidence?: string;
  issueId: string;
  orderId: string;
  groupId: string;
  recipientId: string;
  itemId?: string;
  kind: string;
  sourceSpan?: SourceSpan;
  blockingStage: number;
  severity: "ACTION" | "INFO";
  resolution: IssueResolution;
  resolutionSource: string;
  updatedAt: string;
  title: string;
  detail: string;
  linkKey?: string;
  customer?: string;
  targets?: { recipientId: string; itemId: string; quantity: number | null }[];
}
