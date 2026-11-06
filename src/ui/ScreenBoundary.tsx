import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { readableError } from "../errors";
import type { NoticeSink } from "../shared/notices";
import { Button } from "./Button";
import { EmptyState } from "./PageHeading";
export class ScreenBoundary extends Component<
  { children: ReactNode; onError?: NoticeSink; onRetry: () => Promise<unknown> },
  { failed: boolean; retrying: boolean }
> {
  state = { failed: false, retrying: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error("BANDO HUB screen error", error.message);
  }
  render() {
    return this.state.failed ? (
      <section className="card screen-error">
        <EmptyState
          title="화면을 표시하지 못했습니다."
          description="저장된 업무 내역을 다시 불러와 주세요."
        >
          <Button
            busy={this.state.retrying}
            onClick={async () => {
              this.setState({ retrying: true });
              try {
                await this.props.onRetry();
                this.setState({ failed: false });
              } catch (error) {
                this.props.onError?.(readableError(error), "error");
              } finally {
                this.setState({ retrying: false });
              }
            }}
          >
            다시 불러오기
          </Button>
        </EmptyState>
      </section>
    ) : (
      this.props.children
    );
  }
}
