export class TaskQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      return new Promise<T>((resolve, reject) => {
        this.waiting.push(() => {
          this.run(fn).then(resolve, reject);
        });
      });
    }
    this.active += 1;
    return fn().finally(() => {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    });
  }
}
