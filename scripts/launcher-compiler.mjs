/**
 * Where the C# compiler might be, given an environment.
 *
 * Split out of `build-launcher.mjs` so the search order can be tested as a pure
 * function. A test that manipulates `process.env` is really asserting something
 * about the machine it runs on: it passes here, and on a machine that happens to
 * have a compiler in a different place it either fails for no reason or - worse -
 * stops testing the branch it was written for. Injecting the environment tests the
 * logic; clearing variables simulates one particular machine.
 */

/**
 * Search order, most explicit first.
 *
 * `CSC_PATH` comes first because naming a compiler is a decision; `dotnet` comes
 * last because, while it is on PATH on some machines, it cannot compile a bare .cs
 * file without a project, so it is only ever a "did the machine have anything" signal.
 */
export const compilerCandidates = (env = process.env) => {
  const list = [];
  const fromEnv = env.CSC_PATH;
  if (fromEnv) list.push({ kind: 'csc', path: fromEnv, why: 'CSC_PATH' });

  const windir = env.WINDIR ?? env.SystemRoot ?? '';
  if (windir) {
    list.push({
      kind: 'csc',
      path: [windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'].join('\\'),
      why: 'Framework64 (64-bit compiler, default on Windows 10/11)',
    });
    list.push({
      kind: 'csc',
      path: [windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'].join('\\'),
      why: 'Framework (32-bit compiler)',
    });
  }
  list.push({ kind: 'dotnet', path: 'dotnet', why: 'dotnet on PATH (last resort)' });
  return list;
};

/**
 * First candidate that exists. `exists` is injected so a test can describe a machine
 * without having one.
 */
export const pickCompiler = (candidates, exists) => candidates.find((candidate) => exists(candidate.path)) ?? null;
