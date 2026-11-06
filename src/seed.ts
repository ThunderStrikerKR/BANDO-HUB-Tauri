import type { Order, Product, State } from "./types.js";
export const demoRaw =
  "수취인: 가상고객 하나\n주소: 서울특별시 성동구 가상로 10 (시연용)\n휴대폰: 010-0000-0000\nBD709 블랙 2개\nDEMO-STR 3개\n요청사항: 시연 주문입니다";
const now = "2026-11-02T00:00:00.000Z";
export function seed(): State {
  const products: Product[] = [
    {
      id: "demo709",
      code: "BD 709",
      name: "[가상] BD 709 보면대",
      category: "스탠드",
      origin: "FACTORY",
      defaultColor: "Black",
      active: true,
      createdAt: now,
      updatedAt: now,
      variants: [
        {
          id: "demo709-black",
          color: "Black",
          wholesale: 25000,
          semi: 28000,
          retail: 30000,
          url: "",
          source: "DEMO",
        },
        {
          id: "demo709-gray",
          color: "Gray",
          wholesale: 27000,
          semi: 30000,
          retail: 33000,
          url: "",
          source: "DEMO",
        },
      ],
    },
    {
      id: "demo-str",
      code: "DEMO-STR",
      name: "[가상] 기타줄",
      category: "소모품",
      origin: "STORE",
      defaultColor: "Black",
      active: true,
      createdAt: now,
      updatedAt: now,
      variants: [
        {
          id: "demo-str-black",
          color: "Black",
          wholesale: 5000,
          semi: 6000,
          retail: 7000,
          url: "",
          source: "DEMO",
        },
      ],
    },
  ];
  return {
    products,
    clients: [
      {
        id: "demo-a",
        name: "[가상] A악기사",
        contact: "시연 담당",
        tier: "wholesale",
        shippingFeeExcluded: false,
        payment: "PREPAID",
        active: true,
        identifiers: "시연 A",
        overrides: {},
      },
      {
        id: "demo-b",
        name: "[가상] B악기사",
        contact: "시연 담당",
        tier: "wholesale",
        shippingFeeExcluded: true,
        payment: "POSTPAID",
        active: true,
        identifiers: "시연 B",
        overrides: {},
      },
    ],
    aliases: [
      {
        id: "alias-a",
        clientId: "demo-a",
        text: "보면대",
        productId: "demo709",
      },
      {
        id: "alias-common",
        clientId: null,
        text: "709 보면대",
        productId: "demo709",
      },
    ],
    orders: [],
    queue: [],
    exports: [],
    settings: {
      accounts: [],
      defaultAccountId: "",
      senderName: "반도스탠드",
      senderAddress: "",
      senderPhone: "",
      senderMobile: "",
      rounding: "ROUND",
    },
  };
}
export function blankOrder(clientId: string): Order {
  const at = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    clientId,
    raw: "",
    channel: "카카오톡",
    recipients: [],
    shippingFee: null,
    applyVat: false,
    vatAmount: null,
    status: "RECEIVED",
    notified: false,
    paid: false,
    postpaidApproved: false,
    freightCode: "010",
    createdAt: at,
    updatedAt: at,
  };
}
