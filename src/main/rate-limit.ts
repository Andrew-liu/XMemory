export interface RateState { requests: number; nextAt: number; limited: number }
export class RateLimiter {
  state: RateState
  constructor(state?: RateState, private persist: (s: RateState) => void = () => {}, private clock = () => Date.now(), private random = Math.random) { this.state = state || { requests: 0, nextAt: 0, limited: 0 } }
  remaining() { return Math.max(0, this.state.nextAt - this.clock()) }
  take() {
    if (this.remaining()) throw new Error(`采集冷却中，约 ${Math.ceil(this.remaining() / 1000)} 秒后继续`)
    this.state.requests++
    const pause = this.state.requests % 60 === 0 ? 15 * 60_000 : this.state.requests % 20 === 0 ? (120 + this.random() * 180) * 1000 : (8 + this.random() * 7) * 1000
    this.state.nextAt = this.clock() + pause; this.persist(this.state)
  }
  limit(retryAfterSeconds = 0) { this.state.limited++; this.state.nextAt = this.clock() + Math.max(retryAfterSeconds * 1000, Math.min(86_400_000, 1_800_000 * 2 ** (this.state.limited - 1))); this.persist(this.state) }
}
