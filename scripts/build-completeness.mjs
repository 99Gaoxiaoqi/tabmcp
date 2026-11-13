#!/usr/bin/env node
/**
 * Prove that the compiled output can actually load itself.
 *
 * `tsc` exiting 0 means the types were right. It does not mean every file the
 * runtime will ask for exists in `dist/`. The failure that motivated this script:
 *
 *   tsc                              exit 0
 *   dist/src/host/install.js         present
 *   dist/src/shared/hostname.mjs     absent  (not copied: allowJs was off)
 *   node dist/src/host/install.js    MODULE_NOT_FOUND
 *
 * Every existing gate was green through all of that. So this one starts from the
 * compiled files - not from the TypeScript sources - and asks one question: does
 * every relative specifier in the build output resolve to a file that is there?
 *
 * Starting from the output keeps it small. Type-only imports are already erased by
 * the time we look, `node:` builtins are skipped because only specifiers beginning
 * with `.` are followed, and `.d.ts` files are not scanned. The compiler removed all
 * of that for us; none of it needs a special case here.
 *
 * What this does NOT prove, and must not be described as proving:
 *   - that every module is reachable from an entry point ("resolves" is not "is used")
 *   - that the code inside those files is correct
 *   - that non-relative dependencies (node: builtins, packages) are installed
 *
 * Exit codes:
 *   0  every relative specifier in the build output resolves
 *   1  the check ran and found specifiers pointing at files that are not there
 *   2  the check could not run: no dist/, no compiled modules, unreadable files
 *
 * Usage:
 *   node scripts/build-completeness.mjs [--root <dir>]
 *
 * `--root` exists so a test can aim this at a deliberately damaged copy, which is
 * the only way to show it can fail at all: the real tree is green, so a positive
 * case alone would pass whether or not the check works.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every relative specifier in one compiled file, as written.
 *
 * A scanner, not a regex, on purpose. A regex over the whole file cannot tell an
 * import statement from a *string that contains* an import statement - and the test
 * file for this very script contains such strings, which made the first version
 * report ten imports that did not exist. Matching text is not matching the property.
 *
 * So: walk the file, skip comments, and when a string literal closes, look at the
 * code that preceded it. Only `from`, `import`, and `require(` put a string in a
 * specifier position; anything else is data.
 *
 * Known limit: a specifier inside a template literal with `${...}` is not static and
 * is not followed.
 */
export function relativeSpecifiers(source) {
  const found = [];
  let code = ''; // trailing slice of code seen so far, outside strings and comments
  let i = 0;

  const inSpecifierPosition = () =>
    /\bfrom$/.test(code) || /\bimport$/.test(code) || /\brequire\($/.test(code);

  while (i < source.length) {
    const char = source[i];

    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      let j = i + 1;
      let text = '';
      let dynamic = false;
      while (j < source.length) {
        if (source[j] === '\\') {
          text += source[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (quote === '`' && source[j] === '$' && source[j + 1] === '{') dynamic = true;
        if (source[j] === quote) break;
        text += source[j];
        j += 1;
      }
      if (!dynamic && inSpecifierPosition() && text.startsWith('.')) found.push(text);
      code = ''; // the literal ends the keyword context
      i = j + 1;
      continue;
    }

    if (!/\s/.test(char)) code = (code + char).slice(-32);
    i += 1;
  }

  return found;
}

/**
 * Does a specifier from `fromFile` point at a file that exists?
 *
 * NodeNext requires explicit extensions in relative specifiers, so the target is
 * taken literally. If that ever stops holding, this reports the miss rather than
 * guessing at an extension - a wrong path and a missing file must not look alike.
 */
export function resolves(fromFile, specifier) {
  return fs.existsSync(path.resolve(path.dirname(fromFile), specifier));
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function fail(code, message, data) {
  process.stderr.write(`${message}\n`);
  if (data && Object.keys(data).length > 0) process.stderr.write(`${JSON.stringify(data, null, 2)}\n`);
  process.exit(code);
}

function main() {
  const argv = process.argv.slice(2);
  const option = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };

  // The root defaults to the repository this script lives in: scripts/ -> one level
  // up. Never process.cwd() - that made an identical command behave differently
  // depending on where it was launched from, a defect this project already had once
  // (d3f5a4b).
  const rootArg = option('--root');
  const ROOT = rootArg ? path.resolve(rootArg) : path.resolve(HERE, '..');
  const DIST = path.join(ROOT, 'dist');

  // Only the directories the compiler emits into. `dist/` also collects local scratch
  // files (probe-*.mjs: never committed, never built), and scanning those would let
  // leftover debris turn this gate red - a false positive that teaches people to
  // ignore it, which is how a gate dies.
  const TARGETS = [path.join(DIST, 'src'), path.join(DIST, 'tests')];

  if (!fs.existsSync(DIST)) {
    fail(2, `cannot check build completeness: ${path.relative(ROOT, DIST) || 'dist'}/ does not exist`, {
      root: ROOT,
      hint: 'run `npm run build` first; this check runs after it',
    });
  }

  let files = [];
  for (const target of TARGETS) {
    if (!fs.existsSync(target)) continue;
    try {
      files = files.concat(walk(target).filter((file) => file.endsWith('.js') || file.endsWith('.mjs')));
    } catch (error) {
      fail(2, `cannot read the compiled output: ${error.message}`, { target });
    }
  }

  if (files.length === 0) {
    // An empty output is not a pass: nothing was checked. Printing "0 unresolved"
    // here would be the exact lie this script exists to prevent.
    fail(2, 'cannot check build completeness: no compiled .js or .mjs files under dist/src or dist/tests', {
      dist: DIST,
      hint: 'an empty output directory is a failed build, not a complete one',
    });
  }

  let specifiers = 0;
  const unresolved = [];

  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      fail(2, `cannot read ${path.relative(ROOT, file)}: ${error.message}`);
    }
    for (const specifier of relativeSpecifiers(source)) {
      specifiers += 1;
      if (!resolves(file, specifier)) {
        unresolved.push({ file: path.relative(ROOT, file), specifier });
      }
    }
  }

  if (unresolved.length > 0) {
    process.stderr.write(
      `build completeness: ${unresolved.length} relative import(s) point at files that are not in the build output\n`,
    );
    for (const miss of unresolved) {
      process.stderr.write(`  ${miss.file} -> ${miss.specifier}\n`);
    }
    process.stderr.write('the compiled output cannot load itself; `tsc` exiting 0 does not cover this\n');
    process.exit(1);
  }

  process.stdout.write(
    `build completeness: ${files.length} compiled modules, ${specifiers} relative imports, 0 unresolved\n`,
  );
}

// Only run when invoked as a program. Importing this module (the test does, to probe
// the matcher) must not scan or print anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
