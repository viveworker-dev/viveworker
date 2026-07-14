const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024 * 1024;

export class LengthPrefixedFrameDecoder {
  constructor({ maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    this.maxFrameBytes = Math.max(1, Number(maxFrameBytes) || DEFAULT_MAX_FRAME_BYTES);
    this.reset();
  }

  get bufferedBytes() {
    return this.byteLength;
  }

  reset() {
    this.chunks = [];
    this.headIndex = 0;
    this.byteLength = 0;
  }

  push(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.byteLength += chunk.length;
    }

    const frames = [];
    while (this.byteLength >= 4) {
      const frameBytes = this.peekUInt32LE();
      if (frameBytes > this.maxFrameBytes) {
        this.reset();
        throw new RangeError(`IPC frame exceeds ${this.maxFrameBytes} bytes`);
      }
      if (this.byteLength < frameBytes + 4) {
        break;
      }
      this.consume(4);
      frames.push(this.consume(frameBytes));
    }
    return frames;
  }

  peekUInt32LE() {
    const first = this.chunks[this.headIndex];
    if (first?.length >= 4) {
      return first.readUInt32LE(0);
    }
    const prefix = Buffer.allocUnsafe(4);
    this.copyInto(prefix, 4, false);
    return prefix.readUInt32LE(0);
  }

  consume(length) {
    if (length === 0) {
      return Buffer.alloc(0);
    }
    if (length < 0 || length > this.byteLength) {
      throw new RangeError("Cannot consume beyond buffered IPC bytes");
    }

    const first = this.chunks[this.headIndex];
    if (first.length >= length) {
      const result = first.subarray(0, length);
      if (first.length === length) {
        this.headIndex += 1;
      } else {
        this.chunks[this.headIndex] = first.subarray(length);
      }
      this.byteLength -= length;
      this.compactChunks();
      return result;
    }

    const result = Buffer.allocUnsafe(length);
    this.copyInto(result, length, true);
    return result;
  }

  copyInto(target, length, consume) {
    let remaining = length;
    let targetOffset = 0;
    let chunkIndex = this.headIndex;
    let firstChunkOffset = 0;

    while (remaining > 0) {
      const chunk = this.chunks[chunkIndex];
      if (!chunk) {
        throw new RangeError("Incomplete IPC frame buffer");
      }
      const available = chunk.length - firstChunkOffset;
      const copyLength = Math.min(remaining, available);
      chunk.copy(target, targetOffset, firstChunkOffset, firstChunkOffset + copyLength);
      targetOffset += copyLength;
      remaining -= copyLength;

      if (!consume) {
        chunkIndex += 1;
        firstChunkOffset = 0;
        continue;
      }

      if (copyLength === available) {
        this.headIndex += 1;
        chunkIndex = this.headIndex;
      } else {
        this.chunks[this.headIndex] = chunk.subarray(copyLength);
        chunkIndex = this.headIndex;
      }
      firstChunkOffset = 0;
      this.byteLength -= copyLength;
    }

    if (consume) {
      this.compactChunks();
    }
  }

  compactChunks() {
    if (this.headIndex === this.chunks.length) {
      this.chunks = [];
      this.headIndex = 0;
      return;
    }
    if (this.headIndex >= 1024 && this.headIndex * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.headIndex);
      this.headIndex = 0;
    }
  }
}
