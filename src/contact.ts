/** Recognition keeps malformed input; this validation never turns it into a product. */
export function validContact(value: string) {
  const digits = value.replace(/[\s().-]/g, "");
  return (
    (/^0\d{8,10}$/.test(digits) || /^050\d{9}$/.test(digits)) &&
    (!digits.startsWith("010") || digits.length === 11)
  );
}

export function contactProblem(value: string, mobile = /^01/.test(value)) {
  const digits = value.replace(/[\s().-]/g, "");
  if (!value.trim()) return mobile ? "휴대폰 번호가 없습니다." : "전화번호가 없습니다.";
  if (/^010/.test(digits) && digits.length !== 11)
    return `휴대폰 번호가 ${digits.length}자리입니다. 010으로 시작하는 번호는 숫자 11자리가 필요합니다.`;
  return mobile
    ? "휴대폰 번호의 형식과 자릿수를 확인해주세요."
    : "일반전화 번호의 지역번호와 자릿수를 확인해주세요.";
}
