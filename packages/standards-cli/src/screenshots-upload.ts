// S3 upload helpers keep content-addressed writes atomic and clean up only
// objects this invocation successfully created.

const HTTP_PRECONDITION_FAILED = 412;

export type PublishedScreenshot = {
  readonly key: string;
  readonly line: string;
  readonly created: boolean;
};

export const uploadIfAbsent = async (
  client: Bun.S3Client,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<boolean> => {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  let response: Response;
  try {
    response = await fetch(client.presign(key, { method: 'PUT' }), {
      method: 'PUT',
      headers: {
        'content-type': contentType,
        'if-none-match': '*',
      },
      body,
    });
  } catch (error) {
    throw new Error('S3 upload request failed', { cause: error });
  }
  if (response.status === HTTP_PRECONDITION_FAILED) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`S3 upload failed with HTTP ${response.status}`);
  }
  return true;
};

export const cleanupUploads = async (
  client: Bun.S3Client,
  results: ReadonlyArray<PromiseSettledResult<PublishedScreenshot>>,
): Promise<ReadonlyArray<unknown>> => {
  const keys = new Set(
    results.flatMap((result) =>
      result.status === 'fulfilled' && result.value.created
        ? [result.value.key]
        : [],
    ),
  );
  const cleanupResults = await Promise.allSettled(
    [...keys].map((key) => client.delete(key)),
  );
  return cleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
};
