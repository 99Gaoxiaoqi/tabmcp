#!/usr/bin/env node
/**
 * Build `native-host.exe` from `launcher/Launcher.cs`.
 *
 * Chrome runs the manifest's `path` directly with no arguments, so the host must be
 * an executable; a .cmd wrapper is not an option. The source has no dependencies
 * beyond System/System.Diagnostics/System.IO, so the C# compiler that ships with
 * .NET Framework is enough - no SDK, no NuGet, no project file.
 *
 * The bin is gitignored, so a fresh clone has no host binary and `verify` still
 * passes. That is why this script has to be honest about failure: a green `verify`
 * says nothing about whether the host exists.
 *
 * Exit codes:
 *   0  native-host.exe was produced (and is a non-empty file)
 *   2  it could not be produced, with the reason and the paths that were searched
 *
 * There is no exit 1 and no silent skip: "cannot build" is never reported as success.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compilerCandidates, pickCompiler } from './launcher-compiler.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(REPO_ROOT);

const SOURCE = path.join('launcher', 'Launcher.cs');

// `--out <path>` exists so the build can be exercised without writing over the
// repository's own binary. Tests run this script at the repository root and point
// the output somewhere temporary, instead of copying the script into a fixture - a
// copy breaks whenever this file gains an import, and that failure looks like a
// broken build rather than a stale fixture.
const outIndex = process.argv.indexOf('--out');
const OUTPUT = outIndex >= 0 && process.argv[outIndex + 1] ? process.argv[outIndex + 1] : 'native-host.exe';

const fail = (lines) => {
  for (const line of lines) console.error(line);
  process.exit(2);
};

if (!fs.existsSync(SOURCE)) {
  fail([`cannot build ${OUTPUT}: ${SOURCE} does not exist`, 'this script builds the launcher; it does not generate it']);
}
const sourceBytes = fs.statSync(SOURCE).size;
if (sourceBytes === 0) fail([`cannot build ${OUTPUT}: ${SOURCE} is empty`]);

const searched = compilerCandidates().map((candidate) => `  ${candidate.path}  (${candidate.why})`);
let compiler = null;
// An explicit CSC_PATH is authoritative: if someone names a compiler and it is not
// there, falling back to a different one silently would build with something they
// did not choose, and every later question about the binary would have the wrong answer.
if (process.env.CSC_PATH && !fs.existsSync(process.env.CSC_PATH)) {
  fail([
    `cannot build ${OUTPUT}: CSC_PATH is set but does not exist`,
    `  CSC_PATH=${process.env.CSC_PATH}`,
    'unset CSC_PATH to let the script pick a compiler, or point it at a real one',
  ]);
}
// `exists` is a function because dotnet is resolved from PATH rather than checked on
// disk; a path that is not a file cannot be a compiler either.
compiler = pickCompiler(compilerCandidates(), (candidatePath) => {
  if (candidatePath === 'dotnet') {
    try {
      execFileSync('dotnet', ['--version'], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
  return fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile();
});

if (!compiler) {
  fail([
    `cannot build ${OUTPUT}: no C# compiler found`,
    `searched ${searched.length} candidate${searched.length === 1 ? '' : 's'}:`,
    ...searched,
    '',
    'On Windows 10/11 the .NET Framework compiler ships with the OS at',
    '  %WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'If it is missing, install .NET Framework 4.x, or set CSC_PATH to a compiler.',
    `This is a hard failure on purpose: ${OUTPUT} is gitignored, so a "skip" here would`,
    'leave a clone without a host binary while every other check stays green.',
  ]);
}

const absoluteOutput = path.isAbsolute(OUTPUT) ? OUTPUT : path.join(REPO_ROOT, OUTPUT);
if (fs.existsSync(absoluteOutput)) fs.rmSync(absoluteOutput);

let commandLine;
try {
  if (compiler.kind === 'csc') {
    const args = ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${absoluteOutput}`, SOURCE];
    commandLine = `${compiler.path} ${args.join(' ')}`;
    const output = execFileSync(compiler.path, args, { encoding: 'utf8', stdio: 'pipe' });
    if (output.trim()) {
      for (const line of output.trim().split('\n')) console.log(`  ${line.trim()}`);
    }
  } else {
    // `dotnet` cannot compile a bare .cs file: it needs a project. Saying so is more
    // useful than emitting a csproj here, because a generated project would become a
    // second source of truth for how this binary is built.
    fail([
      'cannot build native-host.exe with dotnet alone',
      '  dotnet was found, but this repository has no launcher project file, and',
      '  `dotnet build` cannot compile a bare .cs file.',
      '  Use the .NET Framework compiler instead (default on Windows), or set CSC_PATH.',
      'searched:',
      ...searched,
    ]);
  }
} catch (error) {
  const details = error instanceof Error ? error.message.split('\n')[0] : String(error);
  fail([
    `cannot build ${OUTPUT}: the compiler failed`,
    `  ${details}`,
    `  command: ${commandLine}`,
    'Fix the compile error above; do not treat this as a warning.',
  ]);
}

// A compiler that exits 0 without writing the file would otherwise look like success.
if (!fs.existsSync(absoluteOutput)) {
  fail([
    `cannot build ${OUTPUT}: the compiler reported success but produced no file`,
    `  expected: ${absoluteOutput}`,
    `  command: ${commandLine}`,
  ]);
}
const produced = fs.statSync(absoluteOutput).size;
if (produced === 0) fail([`cannot build ${OUTPUT}: the produced file is zero bytes`, `  ${absoluteOutput}`]);

console.log(`built ${OUTPUT}: ${produced} B from ${SOURCE} (${sourceBytes} B)`);
console.log(`  compiler: ${compiler.path}`);
console.log(`  command:  ${commandLine}`);
