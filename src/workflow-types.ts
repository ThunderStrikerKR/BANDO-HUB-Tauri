import type { Account, Client, Origin, Price, Recipient } from "./types.js";
export interface WorkflowEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  shipmentIds: string[];
  groupId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}
export interface OrderSource {
  number: number;
  id: string;
  orderId: string;
  dealerId: string;
  raw: string;
  createdAt: string;
}
export interface GroupNotice {
  id: string;
  at: string;
  actor: string;
  shipmentIds: string[];
  amounts: Record<string, number>;
  total: number;
  account: Account;
  message: string;
}
export interface OrderGroup {
  deletedAt?: string;
  messageEdits?: { payment?: string; options?: string };
  id: string;
  sourceId: string;
  dealerId: string;
  createdAt: string;
  rootGroupId: string;
  accountMode?: "AUTO" | "MANUAL";
  accountId?: string;
  notices: GroupNotice[];
  needsNotice: boolean;
}
export interface WorkflowShipment {
  tracking?: Partial<Record<Origin, string>>;
  actualFreight?: Partial<Record<Origin, Price>>;
  collectedAt?: string;
  rechecks?: {
    resolvedAt?: string;
    at: string;
    reason: string;
    fromStage: number;
    toStage: number;
  }[];
  latestRecipient?: Recipient;
  recipientSnapshot?: Recipient;
  appliedEpoch?: number;
  appliedBundles?: {
    origin: Origin;
    key: string;
    versions: Record<string, string>;
    description: string;
  }[];
  id: string;
  sourceId: string;
  orderId: string;
  recipientId: string;
  groupId: string;
  step: number;
  completedAt: Partial<Record<1 | 2 | 3 | 4, string>>;
  charges: Partial<Record<Origin, Price>>;
  chargeMode: "AUTO" | "MANUAL";
  freightVersion: string;
  confirmedFreightVersion?: string;
  infoSignature: string;
  billingSignature?: string;
  sender?: Client;
  transferred: boolean;
  legacyApproval?: boolean;
  legacyArchived?: boolean;
  delivery?: {
    at: string;
    actor: string;
    actual: Partial<Record<Origin, number>>;
    versions: Record<string, string>;
    recordIds: string[];
  };
}
export interface WorkflowPayment {
  id: string;
  dealerId: string;
  account: Account;
  amount: number;
  paidAt: string;
  recordedAt: string;
  actor: string;
  memo: string;
  allocations: { id: string; shipmentId: string; amount: number }[];
}
export interface PaymentConfirmation {
  amounts?: Record<string, number>;
  id: string;
  groupId: string;
  dealerId: string;
  shipmentIds: string[];
  amount: number;
  confirmedAt: string;
  actor: string;
  announcedAccount: Account;
  allocations: { shipmentId: string; amount: number }[];
}
export interface ExcelQueueEntry {
  fileOnly?: boolean;
  factoryDeliveredAt?: string;
  id: string;
  shipmentId: string;
  origin: Origin;
  at: string;
  actor: string;
  status: "QUEUED" | "EXPORTED" | "STORE_SENT" | "CANCELLED";
  snapshot?: {
    recipient: Recipient;
    sender: Client;
    freightCode: "010" | "020";
    total: Price;
    vat: Price;
    subtotal: Price;
    shipping: Price;
  };
  exportId?: string;
  exportedAt?: string;
  legacy?: boolean;
}
export interface DeliveryEvidence {
  id: string;
  shipmentId: string;
  recipientId: string;
  origin: Origin;
  at: string;
  actor: string;
  items: {
    productId: string;
    variantId: string;
    quantity: number;
    shippingGroupId?: string;
  }[];
  bundles: number | null;
  charge: number;
  actual: number;
  version: string;
  combinationId: string;
}
export interface WorkflowState {
  confirmations?: PaymentConfirmation[];
  sources: OrderSource[];
  groups: OrderGroup[];
  shipments: WorkflowShipment[];
  payments: WorkflowPayment[];
  queue: ExcelQueueEntry[];
  events: WorkflowEvent[];
  deliveries: DeliveryEvidence[];
  changeRequests: {
    id: string;
    shipmentId: string;
    at: string;
    actor: string;
    text: string;
    orderId?: string;
    beforeRecipient?: Recipient;
    afterRecipient?: Recipient;
  }[];
}
