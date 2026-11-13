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

function safeName(name: string): string {
  const cleaned = name.replace(UNSAFE, '_').replace(/^\.+/, '').trim();
  return cleaned || 'download.bin';
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

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(captured.path, target);
  } catch (cause) {
    throw new ActionError('E_ACTION_FAILED', `could not save the download to ${target}`, {
      hint: 'Check that the directory is writable.',
      data: { dir, filename, reason: cause instanceof Error ? cause.message : String(cause) },
      cause,
    });
  }

  const { size } = await fs.stat(target);
  return { filename, bytes: size, path: target };
}
