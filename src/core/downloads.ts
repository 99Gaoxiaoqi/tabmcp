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

/** Win32 allows ~260 characters unless long paths are enabled; POSIX allows far more. */
const PATH_LIMIT = process.platform === 'win32' ? 259 : 4096;

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

  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (cause) {
    // "Check that the directory is writable" was the only hint here, and it is the wrong
    // instruction when the directory simply cannot exist.
    throw new ActionError('E_ACTION_FAILED', `could not create ${JSON.stringify(dir)} to save into`, {
      hint: 'The directory could not be created. Check that its parent exists and that you may write there.',
      data: { dir, stage: 'mkdir', reason: cause instanceof Error ? cause.message : String(cause) },
      cause,
    });
  }

  // A too-long path fails later with ENOENT, which reads like "missing directory" when
  // the real cause is the name. Say so before writing anything.
  if (target.length > PATH_LIMIT) {
    throw new ActionError('E_ACTION_FAILED', `could not save ${shown} into ${JSON.stringify(dir)}`, {
      hint:
        `The full path is ${target.length} characters; Windows allows about ${PATH_LIMIT} unless long ` +
        'paths are enabled. Use a shorter directory or pass a shorter filename.',
      data: { dir, filenameLength: filename.length, pathLength: target.length, stage: 'copy' },
    });
  }

  try {
    await fs.copyFile(captured.path, target);
  } catch (cause) {
    throw new ActionError('E_ACTION_FAILED', `could not save ${shown} into ${JSON.stringify(dir)}`, {
      hint: 'Check that the directory is writable and that the file is not open elsewhere.',
      data: { dir, stage: 'copy', reason: cause instanceof Error ? cause.message : String(cause) },
      cause,
    });
  }

  const { size } = await fs.stat(target);
  return { filename, bytes: size, path: target };
}
