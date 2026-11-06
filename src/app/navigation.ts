export const navigation = [
  { id: "접수", label: "접수" },
  { id: "주문내역", label: "주문 내역" },
  { id: "공장목록", label: "엑셀 관리" },
  { id: "결산", label: "일일 결산" },
  { id: "상품", label: "상품 관리" },
  { id: "운임", label: "운임 관리" },
  { id: "거래처", label: "거래처 관리" },
  { id: "설정", label: "설정" },
] as const;
export type PageId = (typeof navigation)[number]["id"];
