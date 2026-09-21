import { parseOszPackage, OszDifficultyEntry } from '../binary/OszParser.ts';

export interface MirrorFetchResult {
  beatmap: OszDifficultyEntry;
  audioBlobUrl?: string;
  backgroundBlobUrl?: string;
  beatmapsetId: number;
  beatmapId: number;
  difficultyRating?: number;
}

/**
 * Client for fetching beatmaps and .osz archives from public mirrors (no supporter tag required)
 */
function isValidZip(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 100) return false;
  const header = new Uint8Array(buf, 0, 2);
  return header[0] === 0x50 && header[1] === 0x4b; // 'PK'
}

export class MirrorClient {
  /**
   * Automatically looks up and downloads a beatmap by MD5 hash from public mirrors
   */
  public static async fetchByMd5(
    hash: string,
    onProgress?: (msg: string) => void
  ): Promise<MirrorFetchResult> {
    const normHash = hash.toLowerCase().trim();
    onProgress?.(`Looking up beatmap metadata for hash ${normHash.slice(0, 8)}...`);

    // Step 1: Query osu.direct (main) with fallback mirrors for beatmap metadata
    let beatmapsetId: number | undefined;
    let beatmapId: number | undefined;
    let difficultyRating: number | undefined;

    const hasWindow = typeof window !== 'undefined';
    const metadataEndpoints = [
      ...(hasWindow ? [`/api/osudirect/api/v2/md5/${normHash}`] : []),
      `https://osu.direct/api/v2/md5/${normHash}`,
      ...(hasWindow ? [`/api/mirror/api/v2/md5/${normHash}`] : []),
      `https://catboy.best/api/v2/md5/${normHash}`
    ];

    for (const ep of metadataEndpoints) {
      try {
        const metaResp = await fetch(ep);
        if (metaResp.ok) {
          const data = await metaResp.json();
          if (data && (data.beatmapset_id || data.id || data.ParentSetID)) {
            beatmapsetId = data.beatmapset_id ?? data.ParentSetID ?? data.id;
            beatmapId = data.id ?? data.BeatmapID ?? data.beatmap_id;
            difficultyRating = typeof data.difficulty_rating === 'number'
              ? data.difficulty_rating
              : (typeof data.DifficultyRating === 'number' ? data.DifficultyRating : undefined);
            break;
          }
        }
      } catch (e) {
        console.warn(`Metadata lookup failed at ${ep}:`, e);
      }
    }

    if (!beatmapsetId) {
      throw new Error(`Beatmap with hash ${normHash} could not be located on mirrors (osu.direct / hinamizawa / catboy).`);
    }

    onProgress?.(`Found beatmapset #${beatmapsetId}. Downloading .osz archive...`);

    // Step 2: Download .osz archive using osu.direct (main) and hinamizawa (fallback)
    const downloadCandidates = [
      ...(hasWindow ? [{ name: 'osu.direct (proxy)', url: `/api/osudirect/api/d/${beatmapsetId}` }] : []),
      { name: 'osu.direct (direct)', url: `https://osu.direct/api/d/${beatmapsetId}` },
      ...(hasWindow ? [{ name: 'hinamizawa (proxy)', url: `/api/hinamizawa/api/v1/hinai/d/${beatmapsetId}` }] : []),
      { name: 'hinamizawa (stream)', url: `https://mirror.hinamizawa.ai/api/v1/hinai/d/${beatmapsetId}` },
      ...(hasWindow ? [{ name: 'hinamizawa (resolve proxy)', url: `/api/hinamizawa/d/${beatmapsetId}` }] : []),
      { name: 'hinamizawa (resolve)', url: `https://mirror.hinamizawa.ai/d/${beatmapsetId}` },
      ...(hasWindow ? [{ name: 'catboy.best (proxy)', url: `/api/mirror/d/${beatmapsetId}` }] : []),
      { name: 'catboy.best (direct)', url: `https://catboy.best/d/${beatmapsetId}` }
    ];

    let oszBuffer: ArrayBuffer | null = null;
    let lastError: Error | null = null;

    for (const cand of downloadCandidates) {
      try {
        onProgress?.(`Fetching .osz from ${cand.name}...`);
        const resp = await fetch(cand.url);
        if (!resp.ok) continue;

        // Check if response is JSON (e.g. hinamizawa returning { download_url: '...' })
        const contentType = resp.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            const data = await resp.json();
            if (data && data.download_url) {
              const directResp = await fetch(data.download_url);
              if (directResp.ok) {
                const buf = await directResp.arrayBuffer();
                if (isValidZip(buf)) {
                  oszBuffer = buf;
                  break;
                }
              }
            }
          } catch {
            // not valid json redirect, continue
          }
          continue;
        }

        const buf = await resp.arrayBuffer();
        if (isValidZip(buf)) {
          oszBuffer = buf;
          break;
        }
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (!oszBuffer) {
      throw new Error(
        `Failed to download .osz package for beatmapset #${beatmapsetId} from mirrors. ${lastError ? lastError.message : ''}`
      );
    }

    onProgress?.(`Extracting .osz package and matching difficulty...`);

    // Step 3: Unpack and locate exact difficulty by MD5
    const pkg = parseOszPackage(oszBuffer, normHash);
    let matchedDiff: OszDifficultyEntry | null = null;

    for (const d of pkg.difficulties) {
      if (d.checksum.toLowerCase() === normHash) {
        matchedDiff = d;
        break;
      }
    }

    // Fallback if hash did not match (e.g. slight editor diff): match by beatmapId
    if (!matchedDiff && beatmapId) {
      for (const d of pkg.difficulties) {
        if (d.beatmap.metadata.beatmapId === beatmapId) {
          matchedDiff = d;
          break;
        }
      }
    }

    // Fallback: use first difficulty if set only has one
    if (!matchedDiff && pkg.difficulties.length > 0) {
      matchedDiff = pkg.difficulties[0];
    }

    if (!matchedDiff) {
      throw new Error(`The downloaded .osz package does not contain a matching .osu file.`);
    }

    return {
      beatmap: matchedDiff,
      audioBlobUrl: pkg.audioBlobUrl,
      backgroundBlobUrl: pkg.backgroundBlobUrl,
      beatmapsetId,
      beatmapId: beatmapId || matchedDiff.beatmap.metadata.beatmapId,
      difficultyRating
    };
  }
}
