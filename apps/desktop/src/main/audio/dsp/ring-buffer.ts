/**
 * Fixed-capacity ring buffer for canonical mono PCM. Writes overwrite the
 * oldest samples when full (real-time audio must never grow unbounded); reads
 * drain oldest-first.
 */
export class PcmRingBuffer {
  private readonly buf: Float32Array;
  private writePos = 0;
  private readPos = 0;
  private count = 0;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error("ring buffer capacity must be positive");
    this.buf = new Float32Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  get capacity(): number {
    return this.buf.length;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  write(samples: ArrayLike<number>): void {
    const n = samples.length;
    if (n === 0) return;
    if (n >= this.buf.length) {
      // completely overwrite: source is larger than the whole ring
      let src = 0;
      if (n > this.buf.length) src = n - this.buf.length;
      for (let i = 0; i < this.buf.length; i++) this.buf[i] = samples[src + i] ?? 0;
      this.writePos = 0;
      this.readPos = 0;
      this.count = this.buf.length;
      return;
    }
    const first = Math.min(n, this.buf.length - this.writePos);
    for (let i = 0; i < first; i++) this.buf[this.writePos + i] = samples[i] ?? 0;
    const second = n - first;
    if (second > 0) for (let i = 0; i < second; i++) this.buf[i] = samples[first + i] ?? 0;
    this.writePos = (this.writePos + n) % this.buf.length;
    const newCount = Math.min(this.buf.length, this.count + n);
    // when capacity is hit, consumed data drops out of the read region
    this.count = newCount;
    this.readPos = (this.writePos - newCount + this.buf.length) % this.buf.length;
  }

  /** Reads up to `max` samples, oldest-first; returns fewer when empty. */
  read(max: number): Float32Array {
    if (max <= 0 || this.count === 0) return new Float32Array(0);
    const n = Math.min(max, this.count);
    const out = new Float32Array(n);
    const first = Math.min(n, this.buf.length - this.readPos);
    for (let i = 0; i < first; i++) out[i] = this.buf[this.readPos + i] ?? 0;
    const second = n - first;
    if (second > 0) for (let i = 0; i < second; i++) out[first + i] = this.buf[i] ?? 0;
    this.readPos = (this.readPos + n) % this.buf.length;
    this.count -= n;
    return out;
  }

  peek(max: number): Float32Array {
    const n = Math.min(max, this.count);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.buf[(this.readPos + i) % this.buf.length] ?? 0;
    return out;
  }

  clear(): void {
    this.writePos = 0;
    this.readPos = 0;
    this.count = 0;
  }
}