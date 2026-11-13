import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * Wave 2, item #31: the lockfile gate, the launcher build, and the host doctor.
 *
 * Two fixture styles, chosen per script rather than uniformly:
 *
 *  - `lockfile-check` and `doctor-host` have no imports, so a throwaway directory
 *    with the script plus its input files states the premise precisely.
 *  - `build-launcher` imports a sibling module, and copying it into a fixture broke
 *    the moment that import appeared - a red that looks like a broken build. It is
 *    exercised in place at the repository root with `--out` pointing at a temporary
 *    path instead, so the repository's own binary is never touched.
 */

const REPO_ROOT = process.cwd();

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

const makeRepo = (
  script: string,
  files: Record<string, string>,
): { dir: string; run: (env?: NodeJS.ProcessEnv, args?: string[]) => Run } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave2-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts', script), path.join(dir, 'scripts', script));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return {
    dir,
    run: (env?: NodeJS.ProcessEnv, args: string[] = []) => {
      const result = spawnSync(process.execPath, [path.join(dir, 'scripts', script), ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: env ?? process.env,
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
};

const json = (value: unknown) => JSON.stringify(value, null, 2);

// ---------------------------------------------------------------- lockfile gate

const LOCK = 'lockfile-check.mjs';
const lockFixture = (pkgDeps: Record<string, string>, lockDeps: Record<string, string>, resolved: string[]) => ({
  'package.json': json({ name: 'fixture', dependencies: pkgDeps }),
  'package-lock.json': json({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: lockDeps },
      ...Object.fromEntries(resolved.map((name) => [`node_modules/${name}`, { version: '1.0.0' }])),
    },
  }),
});

test('lockfile-check: agreeing files exit 0 and report what it compared', () => {
  const repo = makeRepo(LOCK, lockFixture({ zod: '^4.6.7' }, { zod: '^4.6.7' }, ['zod']));
  const result = repo.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 declared dependencies agree with package\.json/);
});

test('lockfile-check: a changed spec is named and exits 1', () => {
  // The difference a local `npm install` repairs silently and `npm ci` refuses to -
  // the whole reason this gate exists.
  const repo = makeRepo(LOCK, lockFixture({ zod: '^4.6.7' }, { zod: '^5.0.0' }, ['zod']));
  const result = repo.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /dependencies\.zod: package\.json \^4\.6\.7 vs package-lock\.json \^5\.0\.0/);
});

test('lockfile-check: a dependency with no resolved entry exits 1', () => {
  const repo = makeRepo(LOCK, lockFixture({ zod: '^4.6.7' }, { zod: '^4.6.7' }, []));
  const result = repo.run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /no node_modules\/zod entry in the lockfile/);
});

// ---------------------------------------------------------------- launcher build

const BUILD = 'build-launcher.mjs';

const runLauncher = (args: string[], env: NodeJS.ProcessEnv = process.env): Run => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', BUILD), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const tempOutput = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-out-')), 'native-host.exe');

test('build-launcher: a CSC_PATH that does not exist fails loudly instead of falling back', () => {
  // An explicit override that silently gets replaced is worse than no override: the
  // binary would be built by something the caller did not choose.
  const out = tempOutput();
  const result = runLauncher(['--out', out], {
    ...process.env,
    CSC_PATH: path.join(os.tmpdir(), 'definitely-not-a-compiler.exe'),
  });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /CSC_PATH is set but does not exist/);
  assert.equal(fs.existsSync(out), false, 'nothing should be built');
});

test('build-launcher: with no compiler reachable it lists what it searched and exits 2', () => {
  // WINDIR is overridden rather than deleted: Windows supplies SystemRoot to every
  // child process even when it is absent from the environment block, so deleting only
  // WINDIR lets the script fall back to the real Windows directory and find a real
  // compiler - the test would then be asserting something about this machine.
  // A temp-derived path also keeps the fixture free of any drive literal, which this
  // repository's own leak scan would (correctly) reject.
  const out = tempOutput();
  const result = runLauncher(['--out', out], {
    PATH: '',
    WINDIR: path.join(os.tmpdir(), '__no_windows_here__'),
  });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /no C# compiler found/);
  // "Fails loudly" includes saying how many places it looked and naming them.
  // Asserting a whole path would only re-encode this machine.
  assert.match(result.stderr, /searched \d+ candidates?:/);
  assert.match(result.stderr, /dotnet/);
  assert.equal(fs.existsSync(out), false, 'a skip must not leave a binary');
});

test('build-launcher: produces a real executable from the real source', () => {
  const out = tempOutput();
  const result = runLauncher(['--out', out]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(out), true, 'the script reported success without writing the binary');
  assert.ok(fs.statSync(out).size > 0, 'the produced file is empty');
  assert.match(result.stdout, /built .*native-host\.exe: \d+ B/);
});

// ---------------------------------------------------------------- host doctor

const DOCTOR = 'doctor-host.mjs';
const doctorFiles = (manifest: Record<string, unknown>) => ({
  'host.config.json': json({ hostName: 'com.local.fixture' }),
  'installed.json': json(manifest),
  'stub.exe': '',
});

test('doctor-host: a manifest whose name differs from host.config.json exits 1', () => {
  const repo = makeRepo(DOCTOR, doctorFiles({ name: 'com.local.other', path: 'stub.exe' }));
  const result = repo.run(process.env, ['--manifest', path.join(repo.dir, 'installed.json'), '--skip-registry']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /manifest name: com\.local\.other != com\.local\.fixture/);
});

test('doctor-host: a manifest pointing at a missing executable exits 1', () => {
  const repo = makeRepo(DOCTOR, doctorFiles({ name: 'com.local.fixture', path: 'gone.exe' }));
  const result = repo.run(process.env, ['--manifest', path.join(repo.dir, 'installed.json'), '--skip-registry']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /executable exists:.*gone\.exe \(not found\)/);
});

test('doctor-host: agreeing config, manifest and executable exit 0', () => {
  const repo = makeRepo(DOCTOR, doctorFiles({ name: 'com.local.fixture', path: 'stub.exe' }));
  const result = repo.run(process.env, ['--manifest', path.join(repo.dir, 'installed.json'), '--skip-registry']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /is installed and points at an existing executable/);
});
