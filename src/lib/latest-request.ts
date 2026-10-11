/**
 * « Latest request wins »: each request takes a ticket; only the response
 * holding the newest ticket may be applied. A slow answer to an older query
 * (the user kept typing) is dropped instead of replacing newer results.
 */
export function createLatestGate() {
  let current = 0;
  return {
    /** Starts a request (and makes every earlier one stale). */
    next(): number {
      current += 1;
      return current;
    },
    /** Invalidates every pending request without starting one (query cleared, dialog closed). */
    cancel(): void {
      current += 1;
    },
    isLatest(ticket: number): boolean {
      return ticket === current;
    },
  };
}
