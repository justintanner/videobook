type VoiceReplyRecovery = { type: "retry"; responseId: string | null } | { type: "failed" };

export class VoiceReplyProgress {
  private waitingAt: number | null = null;
  private responseId: string | null = null;
  private cancellingId: string | null = null;
  private retried = false;

  beginTurn(): void {
    this.waitingAt = null;
    this.responseId = null;
    this.cancellingId = null;
    this.retried = false;
  }

  expect(now: number): void {
    this.waitingAt = now;
  }

  started(responseId: string, now: number): void {
    if (this.cancellingId) return;
    this.responseId = responseId;
    this.waitingAt = now;
  }

  progress(responseId: string, now: number): void {
    if (this.cancellingId || responseId !== this.responseId) return;
    this.waitingAt = now;
  }

  finished(responseId: string | undefined, now: number): "done" | "retry" | "stale" {
    if (responseId && responseId !== this.responseId) return "stale";
    this.responseId = null;
    if (this.cancellingId) {
      this.cancellingId = null;
      this.waitingAt = now;
      return "retry";
    }
    this.waitingAt = null;
    return "done";
  }

  cancelled(now: number): boolean {
    if (!this.cancellingId) return false;
    return this.finished(this.cancellingId, now) === "retry";
  }

  check(now: number): VoiceReplyRecovery | null {
    if (this.waitingAt === null || now - this.waitingAt < (this.cancellingId ? 5000 : 15_000)) return null;
    if (this.retried) {
      this.waitingAt = null;
      return { type: "failed" };
    }
    this.retried = true;
    this.cancellingId = this.responseId;
    this.waitingAt = now;
    return { type: "retry", responseId: this.responseId };
  }
}
