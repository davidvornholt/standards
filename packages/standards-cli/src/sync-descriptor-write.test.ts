import { describe, expect, it } from 'bun:test';
import { writeCompleteDescriptor } from './sync-descriptor-write';

const OVER_REPORTED_WRITE = 3;

const writer = (sizes: Array<number>, written: Array<number>) => ({
  write: (
    contents: Uint8Array,
    offset: number,
    length: number,
    _position: null,
  ): Promise<{ readonly bytesWritten: number }> => {
    const requested = contents.subarray(offset, offset + length);
    written.push(...requested);
    return Promise.resolve({ bytesWritten: sizes.shift() ?? length });
  },
});

describe('complete descriptor writes', () => {
  it('retries short writes without crossing the partial-write boundary', async () => {
    const contents = Buffer.from('abcdefgh');
    const writes: Array<ReadonlyArray<number>> = [];
    const sizes = [1, 2, 1, 2, 2];
    let partialCalls = 0;
    const handle = {
      write: (
        buffer: Uint8Array,
        offset: number,
        length: number,
        _position: null,
      ): Promise<{ readonly bytesWritten: number }> => {
        const bytesWritten = sizes.shift() ?? length;
        writes.push([...buffer.subarray(offset, offset + bytesWritten)]);
        return Promise.resolve({ bytesWritten });
      },
    };

    await writeCompleteDescriptor({
      afterPartialWrite: () => {
        partialCalls += 1;
        expect(
          Buffer.concat(writes.map((value) => Buffer.from(value))).toString(),
        ).toBe('abcd');
        return Promise.resolve();
      },
      contents,
      handle,
      partialOffset: 4,
    });

    expect(partialCalls).toBe(1);
    expect(
      Buffer.concat(writes.map((value) => Buffer.from(value))).toString(),
    ).toBe('abcdefgh');
  });

  it.each([
    0,
    -1,
    OVER_REPORTED_WRITE,
  ])('rejects invalid writer progress %i', async (progress) => {
    const writes: Array<number> = [];
    const sizes = [progress];
    await expect(
      writeCompleteDescriptor({
        contents: Buffer.from('ab'),
        handle: writer(sizes, writes),
      }),
    ).rejects.toThrow('Descriptor write made invalid progress');
  });
});
