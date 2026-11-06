import { DateNavigator } from "./DateNavigator";
import { Field } from "../ui";
import { EmptyState, PageHeading } from "../ui/PageHeading";
export function DailySettlement({
  date,
  onDate,
}: {
  date: string;
  onDate: (date: string) => void;
}) {
  return (
    <section className="daily-settlement">
      <PageHeading
        title="일일 결산"
        actions={
          <Field label="결산 날짜">
            <DateNavigator label="결산 날짜" value={date} onChange={onDate} />
          </Field>
        }
      />
      <div className="card">
        <EmptyState
          title="결산 내역 준비 중"
          description="집계 기준이 확정되면 날짜별 결산 내역을 이곳에서 확인할 수 있습니다."
        />
      </div>
    </section>
  );
}
