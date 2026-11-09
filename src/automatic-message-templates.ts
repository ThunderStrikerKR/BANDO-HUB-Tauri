import type { Settings } from "./types.js";

type TemplateDef = {
  label: string;
  category: "확인 안내" | "색상 및 수량" | "입금 안내";
  description: string;
  body: string;
  variables: readonly string[];
  required: readonly string[];
  sample: Record<string,string>;
};
/** Exact existing message situations, not an arbitrary text replacement engine. */
export const AUTOMATIC_MESSAGE_TEMPLATES = {
  recipientName: {
    label:"수취인 이름 누락",category:"확인 안내",description:"수취인 이름이 누락된 주문의 확인 문구",
    body:"받으실 분의 성함을 알려주세요.",variables:[],required:[],sample:{},
  },
  addressMissing: {
    label:"배송지 주소 누락",category:"확인 안내",description:"배송지가 없는 발주서",
    body:"{수취인}님 배송지 주소 확인 부탁드려요.",variables:["수취인"],required:["수취인"],sample:{"수취인":"김민수"},
  },
  addressDetail: {
    label:"상세주소 부족",category:"확인 안내",description:"기재된 주소가 불완전한 경우",
    body:"{수취인}님 상세주소 확인 부탁드려요.",variables:["수취인"],required:["수취인"],sample:{"수취인":"김민수"},
  },
  contactMissing: {
    label:"수취인 연락처 누락",category:"확인 안내",description:"수취인 연락처가 없거나 올바르지 않을 때",
    body:"{수취인}님 연락처 확인 부탁드려요.",variables:["수취인"],required:["수취인"],sample:{"수취인":"김민수"},
  },
  quantityMissing: {
    label:"주문 수량 확인",category:"확인 안내",description:"상품 수량이 확인되지 않은 경우",
    body:"{상품명} 수량을 확인 부탁드립니다.",variables:["상품명"],required:["상품명"],sample:{"상품명":"BD 709"},
  },
  modelMissing: {
    label:"상품 모델 확인",category:"확인 안내",description:"정확한 모델명이나 상품 선택이 필요한 경우",
    body:"{상품명}: 정확한 모델명을 확인해 주세요.",variables:["상품명"],required:["상품명"],sample:{"상품명":"보면대"},
  },
  modelConfirm: {
    label:"추천 상품 확인",category:"확인 안내",description:"직원이 제안한 상품이 맞는지 안내하는 문구. 링크는 별도 자동 첨부",
    body:"{상품명} 상품으로 보내드리면 될까요?",variables:["상품명"],required:["상품명"],sample:{"상품명":"BD 709"},
  },
  requestRecipient: {
    label:"확인 항목 묶음",category:"확인 안내",description:"여러 누락 항목을 묶어 수취인에게 안내",
    body:"{번호}. {수취인}님: {확인항목}",variables:["번호","수취인","확인항목"],required:["수취인","확인항목"],sample:{"번호":"1","수취인":"김민수","확인항목":"배송지 주소, 연락처"},
  },
  requestClosing: {
    label:"확인 요청 마무리",category:"확인 안내",description:"회신이 필요한 안내 메시지의 마무리",
    body:"위 내용 확인 부탁드립니다.",variables:[],required:[],sample:{},
  },
  colorDefault: {
    label:"대표색상 통보",category:"색상 및 수량",description:"색상이 빠진 발주서에 직원이 지정한 대표색상으로 안내",
    body:"{색상}으로 보내드릴게요.",variables:["색상","상품명"],required:["색상"],sample:{"색상":"블랙","상품명":"BD 709"},
  },
  quantityOne: {
    label:"수량 1개 잠정 안내",category:"색상 및 수량",description:"수량이 없고 1개로 안내한 경우",
    body:"{수취인}님 {상품명} 상품은 수량을 1개로 보내드리겠습니다.",variables:["수취인","상품명"],required:["수취인","상품명"],sample:{"수취인":"김민수","상품명":"BD 709"},
  },
  paymentGreeting: {
    label:"입금 안내 인사말",category:"입금 안내",description:"명세서 안내문 첫머리",
    body:"안녕하세요.",variables:[],required:[],sample:{},
  },
  paymentItem: {
    label:"상품별 금액 표시",category:"입금 안내",description:"상품명, 수량, 가격은 실제 주문 자료로 채움",
    body:"{상품명} * {수량}개 : {금액}",variables:["상품명","수량","금액"],required:["상품명","수량","금액"],sample:{"상품명":"BD 709 (블랙)","수량":"3","금액":"90,000원"},
  },
  paymentFreight: {
    label:"운임 안내",category:"입금 안내",description:"운임은 실제 배송 계산 결과로 채움",
    body:"운임 : {운임}",variables:["운임"],required:["운임"],sample:{"운임":"3,000원"},
  },
  paymentVat: {
    label:"부가세 안내",category:"입금 안내",description:"부가세가 적용되는 경우에만 표시",
    body:"부가세 : {부가세}",variables:["부가세"],required:["부가세"],sample:{"부가세":"9,300원"},
  },
  paymentTotal: {
    label:"총 청구액 안내",category:"입금 안내",description:"정산 결과를 그대로 표시",
    body:"합계 : {합계} 입니다.",variables:["합계"],required:["합계"],sample:{"합계":"102,300원"},
  },
  paymentAccount: {
    label:"입금 계좌 안내",category:"입금 안내",description:"선택된 실제 계좌정보로 채움",
    body:"{은행명} {계좌번호} {예금주} 입니다.",variables:["은행명","계좌번호","예금주"],required:["은행명","계좌번호","예금주"],sample:{"은행명":"국민은행","계좌번호":"000-0000-0000","예금주":"반도"},
  },
  optionsIntro: {
    label:"주문 내용 확인 시작",category:"확인 안내",description:"상품 옵션 확인 안내문의 시작",
    body:"주문하신 내역 확인 부탁드립니다.",variables:[],required:[],sample:{},
  },
  optionsClosing: {
    label:"주문 확인 마무리",category:"확인 안내",description:"상품 옵션 확인 안내문의 마무리",
    body:"주문 내용 확인 후 회신 부탁드립니다.",variables:[],required:[],sample:{},
  },
} as const satisfies Record<string,TemplateDef>;

export type AutomaticTemplateId = keyof typeof AUTOMATIC_MESSAGE_TEMPLATES;
export type AutomaticTemplateEdits = Partial<Record<AutomaticTemplateId,string>>;
export const AUTOMATIC_TEMPLATE_IDS = Object.keys(AUTOMATIC_MESSAGE_TEMPLATES) as AutomaticTemplateId[];

export function validateAutomaticMessageTemplates(edits: AutomaticTemplateEdits) {
  if (Object.keys(edits).length > AUTOMATIC_TEMPLATE_IDS.length)
    throw Error("등록할 수 없는 자동 메시지 유형이 포함됐습니다.");
  for (const [key,text] of Object.entries(edits)) {
    if (!(key in AUTOMATIC_MESSAGE_TEMPLATES))
      throw Error("지원하지 않는 자동 메시지 유형입니다: " + key);
    if (typeof text !== "string" || !text.trim() || text.length > 2000)
      throw Error("자동 메시지는 1자 이상, 2000자 이하로 입력하세요.");
    const def=AUTOMATIC_MESSAGE_TEMPLATES[key as AutomaticTemplateId];
    const variables=new Set<string>(def.variables);
    for (const token of text.matchAll(/\{([^{}]*)\}/g)) {
      if (!variables.has(token[1]))
        throw Error(def.label + ": 지원하지 않는 변수 {" + token[1] + "}입니다.");
    }
    if (text.replace(/\{[^{}]*\}/g,"").includes("{") ||
        text.replace(/\{[^{}]*\}/g,"").includes("}"))
      throw Error(def.label + ": 변수 괄호를 확인하세요.");
    for (const keyRequired of def.required)
      if (!text.includes("{" + keyRequired + "}"))
        throw Error(def.label + ": {" + keyRequired + "} 변수를 삭제할 수 없습니다.");
  }
}

export function templateText(settings: Settings, key:AutomaticTemplateId) {
  return settings.automaticMessageTemplates?.[key] ?? AUTOMATIC_MESSAGE_TEMPLATES[key].body;
}
export function renderAutomaticTemplate(
  settings: Settings,key:AutomaticTemplateId,values:Record<string,string>={}
) {
  const text=templateText(settings,key);
  return text.replace(/\{([^{}]+)\}/g, (_,name:string)=>values[name] ?? "");
}
export function previewAutomaticTemplate(key:AutomaticTemplateId,body:string) {
  const sample:Record<string,string>=AUTOMATIC_MESSAGE_TEMPLATES[key].sample;
  return body.replace(/\{([^{}]+)\}/g,(_,name:string)=>sample[name] ?? "");
}
