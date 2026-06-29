// bobshell isn't published on the public npm registry - IBM's own installer
// (curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash) installs it
// from a directly-hosted tarball, and lets the user pick npm, pnpm, *or*
// yarn to do the global install. Each of those puts global packages in a
// completely different directory, so checking only `npm root -g` misses
// pnpm/yarn installs entirely. Bundling our own copy isn't an option either
// (redistribution of a license-gated CLI, and risk of drifting from
// whatever version the `bob` command actually runs).
//
// The portable fix: resolve `bob` the same way a shell would (PATH lookup),
// then follow symlinks to the real file. All three package managers create
// a bin entry that ultimately points at the literal file named in bobshell's
// own package.json ("bin": {"bob": "bundle/bob.js"}), so resolving the
// symlink lands directly on the bundle, regardless of which one was used.
// This is also exactly how the installer itself verifies success
// (`command_exists bob`).

import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";

const INSTALL_HINT = "Install it with: curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash";

function findOnPath(command) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function viaNpmRootGlobal() {
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const bundlePath = join(globalRoot, "bobshell", "bundle", "bob.js");
    return existsSync(bundlePath) ? bundlePath : null;
  } catch {
    return null;
  }
}

export function locateBobBundle(env = process.env) {
  if (env.BOB_BUNDLE_PATH) {
    if (!existsSync(env.BOB_BUNDLE_PATH)) {
      throw new Error(`BOB_BUNDLE_PATH is set to "${env.BOB_BUNDLE_PATH}" but no file exists there.`);
    }
    return env.BOB_BUNDLE_PATH;
  }

  const onPath = findOnPath("bob");
  if (onPath) {
    try {
      return realpathSync(onPath);
    } catch {
      // fall through to the npm-specific fallback below
    }
  }

  // Covers the unusual case where `bob` isn't on PATH but was still
  // installed globally via npm specifically (e.g. PATH not yet refreshed
  // in the current shell).
  const viaNpm = viaNpmRootGlobal();
  if (viaNpm) return viaNpm;

  throw new Error(
    `Could not locate a bobshell installation (checked PATH for "bob" and "npm root -g"). ${INSTALL_HINT} ` +
      `Or set BOB_BUNDLE_PATH if it's installed somewhere this couldn't find.`,
  );
}

export function bobshellVersion(bundlePath) {
  try {
    const pkgPath = join(bundlePath, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}
