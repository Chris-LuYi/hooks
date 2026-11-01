#!/usr/bin/env node
// Writes or checks ZIP-MANIFEST.json for a repo about to be zipped (ADR-0009, decision 7).
//
//   node scripts/zip-manifest.mjs write [--repo <dir>] [--out <file>] [--run-guards]
//        [--include <label>]... [--cli <dir>] [--engine <dir>] [--toolbox <dir>]
//   node scripts/zip-manifest.mjs check [--repo <dir>] [--file <file>]
//
// `write` reads package names/versions, the git commit and the tested-together versions,
// optionally runs the repo's clean guard, and refuses to emit text with personal markers.
// `check` fails when the manifest is missing, incomplete, stale (commit differs from HEAD)
// or records a failed guard. No dependencies: it must run in every repo.
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"

export const MANIFEST_FILE = "ZIP-MANIFEST.json"
// Same spirit as the per-repo clean guards: nothing personal in a shipped file.
export const FORBIDDEN =
  /chris|luyi|dbs|zustand-demo-archive|~\/Github|\/home\/[a-z]|daas-platform|anthropic|session_0|\/Users\/[A-Za-z]/i
const REQUIRED = [
  "schema",
  "source",
  "packages",
  "matrix",
  "guards",
  "included",
]

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"))

export function readPackages(repo) {
  const out = []
  const add = (dir) => {
    const file = join(dir, "package.json")
    if (!existsSync(file)) return
    const pkg = readJson(file)
    if (pkg.name && pkg.version)
      out.push({ name: pkg.name, version: pkg.version })
  }
  const packagesDir = join(repo, "packages")
  if (existsSync(packagesDir)) {
    for (const d of readdirSync(packagesDir).sort()) add(join(packagesDir, d))
  }
  if (out.length === 0) add(repo)
  return out
}

export function versionOf(dir, name) {
  if (!dir || !existsSync(dir)) return null
  const found = readPackages(dir).find((p) => p.name === name)
  if (found) return found.version
  const file = join(dir, "package.json")
  if (existsSync(file)) {
    const pkg = readJson(file)
    if (pkg.name === name) return pkg.version
  }
  return null
}

function git(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
}

// Which clean guard applies to a repo, found from the files it ships.
export function guardsFor(repo) {
  const guards = []
  const pkgPath = join(repo, "package.json")
  const scripts = existsSync(pkgPath) ? (readJson(pkgPath).scripts ?? {}) : {}
  if (scripts["kb:check"])
    guards.push({
      name: "kb:check",
      cmd: ["bun", "run", "kb:check"],
      cwd: repo,
    })
  if (scripts["check:clean"])
    guards.push({
      name: "check:clean",
      cmd: ["bun", "run", "check:clean"],
      cwd: repo,
    })
  if (existsSync(join(repo, "scripts/check-boundary.mjs")))
    guards.push({
      name: "check-boundary",
      cmd: ["node", "scripts/check-boundary.mjs"],
      cwd: repo,
    })
  const toolbox = join(repo, "packages/daas-toolbox")
  if (existsSync(join(toolbox, "scripts/check-clean.mjs")))
    guards.push({
      name: "check:clean (daas-toolbox)",
      cmd: ["npm", "run", "check:clean"],
      cwd: toolbox,
    })
  return guards
}

export function runGuards(repo) {
  return guardsFor(repo).map((g) => {
    const r = spawnSync(g.cmd[0], g.cmd.slice(1), {
      cwd: g.cwd,
      encoding: "utf8",
    })
    return { name: g.name, passed: r.status === 0 }
  })
}

export function buildManifest({
  repo,
  matrixDirs = {},
  guards = [],
  included = [],
  now,
}) {
  const date = now ?? git(repo, ["log", "-1", "--format=%cI"])
  const manifest = {
    schema: 1,
    source: {
      repo: basename(resolve(repo)),
      commit: git(repo, ["rev-parse", "HEAD"]),
      date,
    },
    packages: readPackages(repo),
    matrix: {
      cli: versionOf(matrixDirs.cli, "@daas-cli/cli"),
      engine: versionOf(matrixDirs.engine, "@daas-base/zustand-engine"),
      toolbox: versionOf(matrixDirs.toolbox, "@daas-sdk/toolbox"),
    },
    guards,
    included,
  }
  return manifest
}

export function findProblems(manifest, headCommit) {
  const problems = []
  for (const key of REQUIRED)
    if (!(key in manifest)) problems.push(`missing field: ${key}`)
  if (manifest.source && headCommit && manifest.source.commit !== headCommit)
    problems.push(
      `stale: manifest commit ${manifest.source.commit} is not HEAD ${headCommit}`,
    )
  if (Array.isArray(manifest.guards)) {
    if (manifest.guards.length === 0) problems.push("no guard results recorded")
    for (const g of manifest.guards)
      if (!g.passed) problems.push(`guard failed: ${g.name}`)
  }
  const text = JSON.stringify(manifest)
  const hit = FORBIDDEN.exec(text)
  if (hit)
    problems.push(`personal or environment text in manifest: "${hit[0]}"`)
  return problems
}

function parseArgs(argv) {
  const args = { include: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--run-guards") args.runGuards = true
    else if (a === "--include") args.include.push(argv[++i])
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i]
    else {
      args._ = args._ ?? []
      args._.push(a)
    }
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._?.[0]
  const repo = resolve(args.repo ?? ".")
  if (cmd === "write") {
    const manifest = buildManifest({
      repo,
      matrixDirs: {
        cli: args.cli ? resolve(args.cli) : resolve(repo, "../daas-cli"),
        engine: args.engine
          ? resolve(args.engine)
          : resolve(repo, "../zustand-engine"),
        toolbox: args.toolbox
          ? resolve(args.toolbox)
          : resolve(repo, "../hooks/packages/daas-toolbox"),
      },
      guards: args.runGuards ? runGuards(repo) : [],
      included: args.include,
    })
    const problems = findProblems(manifest, manifest.source.commit)
    if (problems.length) {
      console.error(
        `zip-manifest: refusing to write:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
      )
      process.exit(1)
    }
    const out = resolve(repo, args.out ?? MANIFEST_FILE)
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`zip-manifest: wrote ${out}`)
    return
  }
  if (cmd === "check") {
    const file = resolve(repo, args.file ?? MANIFEST_FILE)
    if (!existsSync(file)) {
      console.error(
        `zip-manifest: ${file} is missing. Run \`zip-manifest.mjs write --run-guards\` first.`,
      )
      process.exit(1)
    }
    const problems = findProblems(
      readJson(file),
      git(repo, ["rev-parse", "HEAD"]),
    )
    if (problems.length) {
      console.error(
        `zip-manifest: ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`,
      )
      process.exit(1)
    }
    console.log("zip-manifest: ok")
    return
  }
  console.error("usage: zip-manifest.mjs write|check [--repo <dir>] ...")
  process.exit(2)
}

import { fileURLToPath } from "node:url"

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
