/**
 * Where a captured download ends up.
 *
 * Playwright hands back a temporary file with a random name and no extension. That is
 * a valid path, but not a useful one: it is not in the user's Downloads folder, and
 * nothing on disk says it is "probe.txt". Passing `dir` copies it out under its real
 * name; leaving `dir` out keeps the old behaviour exactly as it was.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ActionError } from './errors.js';

export interface CapturedDownload {
  filename?: string;
  bytes?: number;
  path?: string;
}

export interface DownloadDestination {
  /** Directory to copy the file into. Created if missing. */
  dir?: string;
  /** Override the file name; defaults to the name the server suggested. */
  filename?: string;
}

/** Characters that cannot appear in a file name on Windows. */
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Win32 refuses paths longer than about 260 characters unless long paths are enabled.
 * Whether they are enabled cannot be detected reliably from here, so this number is only
 * used to explain a failure that already happened - never to refuse a write up front.
 */
const PATH_LIMIT = 259;

/** One name component cannot exceed this on NTFS, long paths or not. */
const NAME_LIMIT = 255;

/** Enough of a name to recognise it, not enough to bury the message. */
const NAME_SHOWN = 48;

function safeName(name: string): string {
  const cleaned = name.replace(UNSAFE, '_').replace(/^\.+/, '').trim();
  return cleaned || 'download.bin';
}

/** A name that is long enough to be the problem should not also be the message. */
function showName(name: string): string {
  if (name.length <= NAME_SHOWN) return `"${name}"`;
  return `"${name.slice(0, 28)}...${name.slice(-12)}" (${name.length} chars)`;
}

export async function placeDownload(
  captured: CapturedDownload,
  destination: DownloadDestination = {},
): Promise<CapturedDownload> {
  if (!destination.dir) return captured;
  if (!captured.path) {
    throw new ActionError('E_ACTION_FAILED', 'the browser captured a download but reported no temporary file', {
      hint: 'Omit dir to see what the transport returned, or retry the download.',
    });
  }

  const dir = path.resolve(destination.dir);
  const filename = safeName(destination.filename ?? captured.filename ?? 'download.bin');
  const target = path.join(dir, filename);
  const shown = showName(filename);

  // One attempt, then explain. Refusing up front looked safer, but this machine has
  // LongPathsEnabled=1 and writes 307-character paths happily - a pre-check would have
  // rejected work that succeeds.
  let stage: 'mkdir' | 'copy' = 'mkdir';
  try {
    await fs.mkdir(dir, { recursive: true });
    stage = 'copy';
    await fs.copyFile(captured.path, target);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    // A failed copy can leave a partial file behind; the caller asked for a file there,
    // not for half of one.
    await fs.rm(target, { force: true }).catch(() => undefined);

    const hint =
      stage === 'mkdir'
        ? 'The directory could not be created. Check that its parent exists and that you may write there.'
        : filename.length > NAME_LIMIT
          ? `This file name is ${filename.length} characters; Windows allows 255 per name. Pass a shorter filename.`
          : target.length > PATH_LIMIT
            ? `The full path is ${target.length} characters. Windows refuses more than about ${PATH_LIMIT} unless long ` +
              'paths are enabled on this machine, which cannot be detected from here. Use a shorter directory or filename.'
            : 'The copy failed. Check that the directory is writable and has space.';

    throw new ActionError('E_ACTION_FAILED', `could not save ${shown} into ${JSON.stringify(dir)}`, {
      hint,
      data: {
        dir,
        filenameLength: filename.length,
        pathLength: target.length,
        stage,
        reason,
      },
      cause,
    });
  }

  const { size } = await fs.stat(target);
  return { filename, bytes: size, path: target };
}
