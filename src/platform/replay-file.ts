import { MAX_REPLAY_BYTES, parseReplay } from '../sdk/recording';
import type { ReplayData } from '../sdk/recording';

export async function encodeReplay(data: ReplayData): Promise<Blob> {
  const raw = new Blob([JSON.stringify(data)], { type: 'application/json' });
  if (raw.size > MAX_REPLAY_BYTES) throw new RangeError('录像超过 64 MB，请缩短录制时间');
  return new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

/** Read gzip or plain JSON with an enforced decompressed-size limit. */
export async function decodeReplay(file: Blob): Promise<ReplayData> {
  if (file.size > MAX_REPLAY_BYTES) throw new RangeError('录像文件超过 64 MB');
  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const stream =
    magic[0] === 0x1f && magic[1] === 0x8b
      ? file.stream().pipeThrough(new DecompressionStream('gzip'))
      : file.stream();
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_REPLAY_BYTES) {
        await reader.cancel();
        throw new RangeError('录像解压后超过 64 MB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return parseReplay(new TextDecoder().decode(bytes));
}

export async function downloadReplay(data: ReplayData): Promise<void> {
  const blob = await encodeReplay(data),
    url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `boomerang-${data.createdAt.replace(/[:.]/g, '-')}.bgr.gz`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
