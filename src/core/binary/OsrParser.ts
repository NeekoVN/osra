import { BinaryStream } from './BinaryStream.ts';
import { OsrReplay, ReplayFrame } from '../types/replay.ts';
// @ts-expect-error lzma does not have bundled typescript types
import { LZMA } from 'lzma/src/lzma_worker.js';

/**
 * Parses raw .osr replay binary into OsrReplay structure
 */
export async function parseOsrReplay(data: ArrayBuffer | Uint8Array): Promise<OsrReplay> {
  const stream = new BinaryStream(data);

  const gameMode = stream.readByte();
  if (gameMode !== 0) {
    throw new Error(`Unsupported game mode: ${gameMode}. OSRA currently only supports osu!standard (mode 0).`);
  }

  const gameVersion = stream.readInt32();
  const beatmapHash = stream.readOsuString();
  const playerName = stream.readOsuString();
  const replayHash = stream.readOsuString();

  const count300 = stream.readUInt16();
  const count100 = stream.readUInt16();
  const count50 = stream.readUInt16();
  const countGeki = stream.readUInt16();
  const countKatu = stream.readUInt16();
  const countMiss = stream.readUInt16();

  const totalScore = stream.readInt32();
  const maxCombo = stream.readUInt16();
  const isPerfect = stream.readBoolean();
  const mods = stream.readInt32();
  const lifeBarGraph = stream.readOsuString();
  const timestamp = stream.readWindowsDateTime();

  const rawCompressedDataLength = stream.readInt32();
  const compressedBytes = stream.readBytes(rawCompressedDataLength);

  let onlineScoreId = 0n;
  if (stream.remaining >= 8) {
    onlineScoreId = stream.readInt64();
  }

  let soloScoreInfo: import('../types/replay.ts').SoloScoreInfo | undefined;
  let sliderTicks: { hit: number; max: number } | undefined;
  let sliderEnds: { hit: number; max: number } | undefined;
  let rank: string | undefined;

  // osu!lazer attaches a serialized LegacyReplaySoloScoreInfo payload at the end
  if (stream.remaining >= 4) {
    try {
      const extraLen = stream.readInt32();
      if (extraLen > 0 && stream.remaining >= extraLen) {
        const extraBytes = stream.readBytes(extraLen);
        const jsonStr = await decompressLzma(extraBytes);
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === 'object') {
          soloScoreInfo = {
            clientVersion: parsed.client_version,
            rank: parsed.rank,
            userId: parsed.user_id,
            onlineId: parsed.online_id,
            mods: parsed.mods,
            statistics: parsed.statistics || {},
            maximumStatistics: parsed.maximum_statistics || {},
            totalScoreWithoutMods: parsed.total_score_without_mods
          };
          rank = parsed.rank;
          const stats = soloScoreInfo.statistics;
          const maxStats = soloScoreInfo.maximumStatistics;
          if (stats && maxStats) {
            if (maxStats.large_tick_hit !== undefined) {
              sliderTicks = {
                hit: stats.large_tick_hit ?? 0,
                max: maxStats.large_tick_hit
              };
            }
            if (maxStats.slider_tail_hit !== undefined) {
              sliderEnds = {
                hit: stats.slider_tail_hit ?? 0,
                max: maxStats.slider_tail_hit
              };
            }
          }
        }
      }
    } catch {
      // Non-lazer or uncompressed extra payload, ignore gracefully
    }
  }

  // Decompress LZMA replay stream
  const rawReplayString = await decompressLzma(compressedBytes);
  const { frames, rngSeed, skipGaps } = parseReplayFrames(rawReplayString);

  return {
    gameMode,
    gameVersion,
    beatmapHash,
    playerName,
    replayHash,
    count300,
    count100,
    count50,
    countGeki,
    countKatu,
    countMiss,
    totalScore,
    maxCombo,
    isPerfect,
    mods,
    lifeBarGraph,
    timestamp,
    rawCompressedDataLength,
    onlineScoreId,
    frames,
    rngSeed,
    skipGaps,
    soloScoreInfo,
    sliderTicks,
    sliderEnds,
    rank
  };
}

/**
 * Decompresses LZMA byte array into raw UTF-8 replay string
 */
export function decompressLzma(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      LZMA.decompress(bytes, (result: string | number[] | null, error: unknown) => {
        if (error) {
          reject(error);
        } else if (typeof result === 'string') {
          resolve(result);
        } else if (Array.isArray(result)) {
          const uint8 = new Uint8Array(result);
          resolve(new TextDecoder().decode(uint8));
        } else {
          reject(new Error('LZMA decompression failed with null output'));
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Parses decoded replay string ("w|x|y|z,") into normalized monotonic ReplayFrame[]
 * and detects skip gaps
 */
export function parseReplayFrames(rawString: string): {
  frames: ReplayFrame[];
  rngSeed?: number;
  skipGaps?: Array<{ from: number; to: number }>;
} {
  const chunks = rawString.split(',');
  const rawFrames: ReplayFrame[] = [];
  let currentTime = 0;
  let rngSeed: number | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i].trim();
    if (!chunk) continue;

    const parts = chunk.split('|');
    if (parts.length < 4) continue;

    const timeDelta = parseFloat(parts[0]);
    const x = parseFloat(parts[1]);
    const y = parseFloat(parts[2]);
    const keys = parseInt(parts[3], 10) || 0;

    // Special case: RNG seed encoding marker in osu! (-12345 or legacy -2560)
    if (timeDelta === -12345 || timeDelta === -2560) {
      rngSeed = keys;
      continue;
    }

    currentTime += timeDelta;

    rawFrames.push({
      timeDelta,
      time: currentTime,
      x,
      y,
      keys
    });
  }

  // Apply legacy osu! frame normalization (as in osu!lazer LegacyScoreDecoder / osu!stable ReplayWatcher):
  if (rawFrames.length >= 2 && rawFrames[1].time < rawFrames[0].time) {
    rawFrames[1].time = rawFrames[0].time;
    rawFrames[0].time = 0;
  }

  if (rawFrames.length >= 3 && rawFrames[0].time > rawFrames[2].time) {
    rawFrames[0].time = rawFrames[1].time = rawFrames[2].time;
  }

  // Remove osu!stable intro dummy frames placed at (256, -500)
  if (rawFrames.length >= 2 && rawFrames[1].x === 256 && rawFrames[1].y === -500) {
    rawFrames.splice(1, 1);
  }
  if (rawFrames.length >= 1 && rawFrames[0].x === 256 && rawFrames[0].y === -500) {
    rawFrames.splice(0, 1);
  }

  // Enforce monotonic non-decreasing timestamps (ignore backwards time traversal)
  const frames: ReplayFrame[] = [];
  let lastTime = -Infinity;
  for (const f of rawFrames) {
    if (f.time >= lastTime) {
      frames.push(f);
      lastTime = f.time;
    }
  }

  // Detect skip gaps (> 1000ms jump between consecutive frames)
  const skipGaps: Array<{ from: number; to: number }> = [];
  for (let i = 1; i < frames.length; i++) {
    const diff = frames[i].time - frames[i - 1].time;
    if (diff > 1000) {
      skipGaps.push({ from: frames[i - 1].time, to: frames[i].time });
    }
  }

  return { frames, rngSeed, skipGaps };
}
