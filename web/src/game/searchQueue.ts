// Path searches plugins ask for (hq.walkTo), run a few per frame. A plugin may send hundreds of walks
// in one batch; searching them all at once would freeze the page. One pending search per sprite: a
// newer goal replaces the older one, so the queue never holds more than the sprites that exist.

export class SearchQueue<G> {
  private pending = new Map<string, { goal: G; run: (goal: G) => void }>();
  private perFrame: number;

  constructor(perFrame: number) {
    this.perFrame = perFrame;
  }

  get size() {
    return this.pending.size;
  }

  request(id: string, goal: G, run: (goal: G) => void) {
    this.pending.delete(id); // to the back of the line with its new goal
    this.pending.set(id, { goal, run });
  }

  cancel(id: string) {
    this.pending.delete(id);
  }

  /** Runs at most perFrame searches, oldest first. */
  run() {
    let n = 0;
    for (const [id, job] of this.pending) {
      if (n++ >= this.perFrame) break;
      this.pending.delete(id);
      job.run(job.goal);
    }
  }
}
