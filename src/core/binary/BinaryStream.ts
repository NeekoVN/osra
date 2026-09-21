/**
 * High-performance binary stream reader wrapping ArrayBuffer / DataView
 * specifically optimized for osu! .osr binary structures
 */
export class BinaryStream {
  private view: DataView;
  private buffer: Uint8Array;
  private offset: number = 0;
  private decoder = new TextDecoder('utf-8');

  constructor(data: ArrayBuffer | Uint8Array) {
    if (data instanceof Uint8Array) {
      this.buffer = data;
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.buffer = new Uint8Array(data);
      this.view = new DataView(data);
    }
  }

  public get position(): number {
    return this.offset;
  }

  public get length(): number {
    return this.buffer.byteLength;
  }

  public get remaining(): number {
    return this.buffer.byteLength - this.offset;
  }

  public isEOF(): boolean {
    return this.offset >= this.buffer.byteLength;
  }

  public seek(position: number): void {
    if (position < 0 || position > this.buffer.byteLength) {
      throw new RangeError(`Seek position ${position} out of bounds (0..${this.buffer.byteLength})`);
    }
    this.offset = position;
  }

  public readByte(): number {
    const val = this.view.getUint8(this.offset);
    this.offset += 1;
    return val;
  }

  public readBoolean(): boolean {
    return this.readByte() !== 0;
  }

  public readInt16(): number {
    const val = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return val;
  }

  public readUInt16(): number {
    const val = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return val;
  }

  public readInt32(): number {
    const val = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return val;
  }

  public readUInt32(): number {
    const val = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return val;
  }

  public readInt64(): bigint {
    const val = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return val;
  }

  public readUInt64(): bigint {
    const val = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return val;
  }

  public readFloat32(): number {
    const val = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return val;
  }

  public readFloat64(): number {
    const val = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return val;
  }

  public readBytes(length: number): Uint8Array {
    if (this.offset + length > this.buffer.byteLength) {
      throw new RangeError(`Attempt to read ${length} bytes with only ${this.remaining} remaining`);
    }
    const slice = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  /**
   * Reads a variable-length unsigned LEB128 integer
   */
  public readULEB128(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      const byte = this.readByte();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) {
        throw new Error('ULEB128 integer overflow');
      }
    }
    return result;
  }

  /**
   * Reads an osu! standard string:
   * 0x00 = empty / null
   * 0x0B = followed by ULEB128 length and UTF-8 bytes
   */
  public readOsuString(): string {
    const flag = this.readByte();
    if (flag === 0x00) return '';
    if (flag !== 0x0b) {
      throw new Error(`Invalid osu! string flag: 0x${flag.toString(16)} at offset ${this.offset - 1}`);
    }

    const length = this.readULEB128();
    if (length === 0) return '';

    const bytes = this.readBytes(length);
    return this.decoder.decode(bytes);
  }

  /**
   * Converts Windows 64-bit .NET DateTime ticks (100-nanosecond intervals since Jan 1, 0001 UTC) to JavaScript Date
   */
  public readWindowsDateTime(): Date {
    const ticks = this.readInt64();
    // Ticks between 0001-01-01 and 1970-01-01 = 621355968000000000n
    const epochTicks = 621355968000000000n;
    const ticksSinceEpoch = ticks - epochTicks;
    const millis = Number(ticksSinceEpoch / 10000n);
    return new Date(millis);
  }
}
