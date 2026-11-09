export class ProjectTurns {
  private readonly lastTurn = new Map<string, Promise<void>>();

  async run<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.lastTurn.get(projectId) ?? Promise.resolve();
    let finish!: () => void;
    const mine = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const turn = previous.then(() => mine);
    this.lastTurn.set(projectId, turn);
    await previous;
    try {
      return await work();
    } finally {
      finish();
      if (this.lastTurn.get(projectId) === turn) this.lastTurn.delete(projectId);
    }
  }
}
