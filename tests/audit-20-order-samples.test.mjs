import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
/** Structurally preserved, privacy-scrubbed representations of 18 text orders
 * and two manually transcribed images. Image OCR itself is NOT assessed. */
const state=JSON.parse(readFileSync(new URL("../src-tauri/resources/state-seed.json",import.meta.url),"utf8"));
const {parseEvidence}=await tsImport("../src/parser.ts",import.meta.url);
const client={id:"ci-dealer",name:"가상거래처",tier:"wholesale",overrides:{},
active:true,payment:"PREPAID",identifiers:"",shippingFeeExcluded:false};

const samples=[
  {
    "id": 1,
    "label": "3품목, 2전화번호, 예약 출고",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      30,
      1,
      2
    ],
    "raw": "안녕하세요 ^^\n** 10월 12일(월) 발송부탁드리며 **\n** 연락처 2개 다 넣어주세요^^ **\n강원특별자치도 홍천군 내촌면 동창로 207\n가상고등학교\n010-1234-5678\n010-1111-2222\n연주용보면대 708-1 / 30개\n지휘자보면대 BD CONDUCTOR / 1개\n보면대카트 Cart-10 / 2개"
  },
  {
    "id": 2,
    "label": "0504 안심번호 / BD-950",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      2
    ],
    "raw": "김가상 예수아님\n0504-1234-5678\n서울특별시 용산구 한강대로104라길 13 (후암동) 가상교회 2층\nBD-950 *2개 선출고부탁드립니다."
  },
  {
    "id": 3,
    "label": "270 2개 / 금액과 VAT 혼입",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      2
    ],
    "raw": "270 2개\n104,000\n배송료\n6,000\n110,000 + 부가세\n121,000원 입니다~\n2개 발송 요청드립니다.\n박가상 010-1234-5678\n(21534) 인천 남동구 구월말로 51 가상교회 사무실"
  },
  {
    "id": 4,
    "label": "250CC 크롬 / 운임 문의",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      1
    ],
    "raw": "안녕하세요^^\n일자스탠드 250CC (크롬) 1개 택배 발송 부탁합니다~\n경기 김포시 대곶면 소래로 41번길 66-73\n가상월드\nTEL 031-123-4567\n운임까지 알려주시면 입금하겠습니다."
  },
  {
    "id": 5,
    "label": "표제 품목 / Z-1 건반",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      1
    ],
    "raw": "■가상센터 발주서■\nㅇ품목\nZ-1(건반 스탠드) * 1EA\nㅇ수령정보\n서울 송파구 석촌호수로 162 가상교회\n정가상 목사\n010-1234-5678"
  },
  {
    "id": 6,
    "label": "지휘용 악보 스탠드 / 수량 없음",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      1
    ],
    "raw": "안녕하세요? 주문드립니다.\nBANDO STAND 반도 보면대 지휘용 악보 스탠드\n받으시는 분\n남가상\n받으시는 분\n010-1234-5678\n배송지 주소\n50034 경상남도 함양군 함양읍 함양여중길 18-9 (가상학교)\n오늘 발송 가능한가요? 송장번호 부탁드립니다."
  },
  {
    "id": 7,
    "label": "409 / 수취인 주소 연락처 한 줄",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      1
    ],
    "raw": "반도 Bando 409 건반 스탠드 1개\n청소년활동팀(1층)(김가상) (12416) 경기도 가평군 가평읍 문화로 120 (가평 청소년 문화의 집) 1층 010-1234-5678"
  },
  {
    "id": 8,
    "label": "BD 950 / 6개 / 문안 요청",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      6
    ],
    "raw": "BD 950       6  개   ㅣ   임가상       전라북도 군산시 회현면 구율2길 19     010-1234-5678\n(배송요청 : 문안에 넣어주세요)"
  },
  {
    "id": 9,
    "label": "Boss101 / 송하인 별도",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      2
    ],
    "raw": "반도스탠드 BD Boss101 수량 : 2개\n받는분 : 이가상\n연락처 : 010-1234-5678\n받는곳 : 경상남도 창원시\n         진해구 안청남로 40\n         가상카페 1층\n배송메모 :\n보내는분 : 가상오디오\n연락처 : 02-123-4567\n보내는곳 : 서울시 마곡중앙4로 22\n          가상빌딩 B동 913호"
  },
  {
    "id": 10,
    "label": "중복 모델명 / 709 블랙",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      1
    ],
    "raw": "반도 악보스탠드 709, 반도보면대 709(블랙)-1개\n수취인명    심가상    연락처(안심번호) 0502-1234-5678\n배송주소    (11806) 경기도 의정부시 민락동 산들마을아파트 410동 804호\n배송메모    문 앞"
  },
  {
    "id": 11,
    "label": "BD-LP-WA A타입",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      1
    ],
    "raw": "안녕하세요 ! 가상프로 발주드립니다.\n모델명 : BD-LP-WA A타입 수량 : 1ea\n성함 : 상가상\n번호 : 010-1234-5678\n주소 : 서울특별시 도봉구 도봉로133길 50 (쌍문동, 가상교회) 사무실 앞"
  },
  {
    "id": 12,
    "label": "연락처 주소 다음 709 3개",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      3
    ],
    "raw": "배가상 010-1234-5678\n인천광역시 미추홀구 석정로461번길 7 (주안동, 가상빌딩) 102호 가상교회 행정실\nBANDO 709 3개"
  },
  {
    "id": 13,
    "label": "배송지 2개 / SSB 2개 705 1개",
    "kind": "TEXT",
    "expectedRecipients": 2,
    "expectedQuantities": [
      2,
      1
    ],
    "raw": "반도 SSB 가방 2EA\n장가상 0502-1234-5678\n광주광역시 광산구 월곡동 538-1 가상아파트 101동 1209호\n택배 선불\n반도 705 보면대 1EA\n정가상 0502-2345-6789\n인천광역시 영종구 하늘달빛로 113 가상아파트 75 3동1705호\n택배 선불입니다."
  },
  {
    "id": 14,
    "label": "BC-105 / 수량 단위 생략",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      1
    ],
    "raw": "안녕하세요 직발송 부탁드립니다.\n반도 첼로스탠드 BC-105 1\n수령자 : 김가상\n휴대전화 : 010-1234-5678\n주소 : [63644] 제주특별자치도 서귀포시 대정읍 에듀시티로 23 (대정읍, 가상아파트) 105동 403호"
  },
  {
    "id": 15,
    "label": "BD 609 Black <3대>",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      3
    ],
    "raw": "@@가상거래처발주@@\n반도 보면대 BD 609 (Black) <3대>\n김가상 010-1234-5678\n경기도 안양시 만안구 안양천서로 177 (안양동, 가상아파트) 216동 101호"
  },
  {
    "id": 16,
    "label": "CONDUCTOR (1ea) / 안심번호",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      1
    ],
    "raw": "BD CONDUCTOR (1ea)\n배가상\n연락처(안심번호) 0502-1234-5678\n배송주소 (12547) 경기도 양평군 양평읍 백운길 199 가상교회\n배송메모 문 앞"
  },
  {
    "id": 17,
    "label": "배송지 2개 / 비표준 광역시 문자열",
    "kind": "TEXT",
    "expectedRecipients": 2,
    "expectedQuantities": [
      4,
      1
    ],
    "raw": "안녕하세요 직발 요청드립니다\n김가상\n010-1234-5678\n전남광주통합특별시 순천시 가곡길 39 (가곡동) 가상교회\nBD 709 (블랙) 4개\n메모 문 앞에 놓아주세요\n박가상\n010-2345-6789\n전라남도 순천시 팔마1길 25 (연향동, 가상아파트) 101동 1003호\n반도 뮤직트레이 그레이 1개\n메모 문 앞에 놓아주세요"
  },
  {
    "id": 18,
    "label": "709 민판 한개 / 수취인 한 줄",
    "kind": "TEXT",
    "expectedRecipients": 1,
    "expectedQuantities": [
      1
    ],
    "raw": "반도 709 민판 한개 이가상 010-1234-5678 경기도 화성시 동탄구 동탄역로 196(여울동, 가상건물) 상가 226호"
  },
  {
    "id": 19,
    "label": "이미지 표 / BB-3 의자 한 개",
    "kind": "IMAGE_TRANSCRIPTION",
    "expectedRecipients": 1,
    "expectedQuantities": [
      1
    ],
    "raw": "발 주 서\n발주일자 2026년 10월 22일\n공급받는자 CSM 가상회사\n품목 | 제품명 | 단위 | 수량 | 비고\n연주용의자 | BB-3 | EA | 1 | 여가상 / 0502-1234-5678 / (51263) 경상남도 창원시 마산합포구 완월동 206-1 가상여자중학교\n빠른 출고 부탁드려요"
  },
  {
    "id": 20,
    "label": "이미지 표 / Desk TS-2 + 배송비 행",
    "kind": "IMAGE_TRANSCRIPTION",
    "expectedRecipients": 1,
    "expectedQuantities": [
      1
    ],
    "raw": "발 주 서\n발주일 2026-11-03\n수주처 반도스탠드\n발주처 가상교육\n납품장소\n배송지 주소 경북 경산시 원효로 309-6 가상교육지원청\n받는 사람 이가상 선생님\n연락처 053-123-4567 / 010-1234-5678\nNO | 품명 | 수량 | 단가 | 금액\n1 | 반도스탠드 마이크 스탠드 T자형 탁상용 BD Desk TS-2 | 1 | | -\n2 | 배송비 | 1 | | -\n합계금액 일금 영원정 VAT 포함"
  }
];

assert.equal(samples.length,20);
for (const sample of samples) {
  test("ORDER_SAMPLE_"+String(sample.id).padStart(2,"0")+" "+sample.label,()=>{
    const parsed=parseEvidence(sample.raw,client,state);
    const recipients=parsed.recipients;
    const actual=recipients.flatMap(r=>r.items.map(i=>i.quantity));
    const summary={
      id:sample.id,label:sample.label,kind:sample.kind,
      expectedRecipients:sample.expectedRecipients,gotRecipients:recipients.length,
      expectedQuantities:sample.expectedQuantities,gotQuantities:actual,
      recipients:recipients.map(r=>({
        name:r.name,address:!!r.address,phone:!!(r.mobile||r.phone),
        addressStatus:r.addressStatus,
        items:r.items.map(i=>({
          raw:i.raw.slice(0,100),name:i.name,quantity:i.quantity,
          quantityConfirmed:i.quantityConfirmed,productId:i.productId,
          variantId:i.variantId,color:i.color,
          match:i.match?.kind,issues:i.issues,
        })),
        orphanEvidence:(r.unassignedEvidence??[]).map(e=>e.kind+":"+e.text.slice(0,30)),
      })),
      evidenceCount:parsed.evidence?.length??0,
    };
    summary.recipientCountOK=summary.gotRecipients===summary.expectedRecipients;
    summary.quantitiesOK=JSON.stringify(actual.map(String).sort())===
      JSON.stringify(sample.expectedQuantities.map(String).sort());
    console.log("ORDER20_RESULT "+JSON.stringify(summary));
    assert.equal(recipients.length,sample.expectedRecipients,"Wrong number of deliveries");
    assert.equal(summary.quantitiesOK,true,"Missing or misassociated quantities");
  });
}
