export type DescriptorWriter = {
  readonly write: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ) => Promise<{ readonly bytesWritten: number }>;
};

export const writeCompleteDescriptor = async ({
  afterPartialWrite,
  contents,
  handle,
  partialOffset,
}: {
  readonly afterPartialWrite?: () => Promise<void>;
  readonly contents: Uint8Array;
  readonly handle: DescriptorWriter;
  readonly partialOffset?: number;
}): Promise<void> => {
  if (
    partialOffset !== undefined &&
    !(partialOffset > 0 && partialOffset <= contents.byteLength)
  ) {
    throw new Error('Descriptor partial-write boundary is invalid');
  }
  let offset = 0;
  let pendingPartialOffset = partialOffset;
  while (offset < contents.byteLength) {
    const end = pendingPartialOffset ?? contents.byteLength;
    const requested = end - offset;
    // biome-ignore lint/performance/noAwaitInLoops: short writes must be completed on the same descriptor before publication can continue.
    const { bytesWritten } = await handle.write(
      contents,
      offset,
      requested,
      null,
    );
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > requested
    ) {
      throw new Error('Descriptor write made invalid progress');
    }
    offset += bytesWritten;
    if (pendingPartialOffset !== undefined && offset === pendingPartialOffset) {
      pendingPartialOffset = undefined;
      await afterPartialWrite?.();
    }
  }
};
