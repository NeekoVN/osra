import * as fflate from 'fflate';
import { md5 } from './md5.ts';
import { parseOsuBeatmap } from './OsuParser.ts';
import { Beatmap } from '../types/beatmap.ts';

export interface OszDifficultyEntry {
  filename: string;
  diffName: string;
  checksum: string;
  content: string;
  beatmap: Beatmap;
}

export interface OszPackage {
  files: Record<string, Uint8Array>;
  difficulties: OszDifficultyEntry[];
  audioFilename?: string;
  audioBlobUrl?: string;
  backgroundFilename?: string;
  backgroundBlobUrl?: string;
}

/**
 * Extracts a .osz archive (zip format) and indexes all beatmap difficulties and media
 */
export function parseOszPackage(data: ArrayBuffer | Uint8Array, targetHash?: string): OszPackage {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const unzipped = fflate.unzipSync(bytes);

  const difficulties: OszDifficultyEntry[] = [];
  let audioFilename: string | undefined;
  let audioBlobUrl: string | undefined;
  let backgroundFilename: string | undefined;
  let backgroundBlobUrl: string | undefined;

  const decoder = new TextDecoder('utf-8');

  // Process .osu files first
  for (const filename in unzipped) {
    if (filename.toLowerCase().endsWith('.osu')) {
      const fileBytes = unzipped[filename];
      const text = decoder.decode(fileBytes);
      const checksum = md5(fileBytes);

      try {
        const beatmap = parseOsuBeatmap(text);
        difficulties.push({
          filename,
          diffName: beatmap.metadata.version || filename,
          checksum,
          content: text,
          beatmap
        });

        // Extract audio file name from the first or matching beatmap
        if (!audioFilename || (targetHash && checksum.toLowerCase() === targetHash.toLowerCase())) {
          // Parse AudioFilename from [General] section
          const match = text.match(/AudioFilename\s*:\s*([^\r\n]+)/i);
          if (match && match[1]) {
            audioFilename = match[1].trim();
          }
        }

        // Extract background file name from [Events] section
        if (!backgroundFilename || (targetHash && checksum.toLowerCase() === targetHash.toLowerCase())) {
          const bgMatch = text.match(/0\s*,\s*0\s*,\s*"([^"]+)"/i) || text.match(/0\s*,\s*0\s*,\s*([^,\r\n]+)/i);
          if (bgMatch && bgMatch[1]) {
            backgroundFilename = bgMatch[1].trim().replace(/^"|"$/g, '');
          }
        }
      } catch (e) {
        console.warn(`Failed to parse beatmap difficulty ${filename}:`, e);
      }
    }
  }

  // Extract audio file if found in zip
  if (audioFilename) {
    const normAudio = audioFilename.toLowerCase();
    for (const filename in unzipped) {
      if (filename.toLowerCase() === normAudio) {
        const audioBytes = unzipped[filename];
        const blob = new Blob([audioBytes], { type: 'audio/mpeg' });
        audioBlobUrl = URL.createObjectURL(blob);
        break;
      }
    }
  }

  // Locate background image in archive (.jpg / .jpeg / .png / .webp)
  let bgBytes: Uint8Array | undefined;
  if (backgroundFilename) {
    const targetBg = backgroundFilename.toLowerCase();
    for (const filename in unzipped) {
      if (filename.toLowerCase() === targetBg) {
        backgroundFilename = filename;
        bgBytes = unzipped[filename];
        break;
      }
    }
  }

  // Fallback: locate first non-skin image file
  if (!bgBytes) {
    for (const filename in unzipped) {
      const lower = filename.toLowerCase();
      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp')) {
        if (!lower.includes('hit') && !lower.includes('comb') && !lower.includes('play') && !lower.includes('slider') && !lower.includes('particle')) {
          backgroundFilename = filename;
          bgBytes = unzipped[filename];
          break;
        }
      }
    }
  }

  if (bgBytes && backgroundFilename) {
    const lower = backgroundFilename.toLowerCase();
    const mime = lower.endsWith('.png') ? 'image/png' : (lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    const blob = new Blob([bgBytes as BlobPart], { type: mime });
    backgroundBlobUrl = URL.createObjectURL(blob);
  }

  return {
    files: unzipped,
    difficulties,
    audioFilename,
    audioBlobUrl,
    backgroundFilename,
    backgroundBlobUrl
  };
}

/**
 * Finds the matching difficulty from an extracted .osz package given an MD5 hash
 */
export function findMatchingDifficulty(pkg: OszPackage, beatmapHash: string): OszDifficultyEntry | null {
  const normHash = beatmapHash.toLowerCase().trim();
  for (const diff of pkg.difficulties) {
    if (diff.checksum.toLowerCase() === normHash) {
      return diff;
    }
  }
  return null;
}
