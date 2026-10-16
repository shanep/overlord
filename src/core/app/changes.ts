// Tells open panels to re-render. Every data change in the app ends here.

export class ChangeHub {
  private readonly listeners = new Set<() => void>();

  on(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
