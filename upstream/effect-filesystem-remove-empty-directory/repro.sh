#!/bin/sh
# Shows FileSystem.remove refusing an empty directory unless `recursive` is set, which also deletes what others placed
# inside a directory: `sh repro.sh <a directory whose node_modules hold effect and @effect/platform-node>`.
set -eu
dir="$(cd "$1" && pwd)"
node --input-type=module - "$dir" <<'JS'
import { createRequire } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
const require = createRequire(process.argv[2] + "/package.json")
const { NodeFileSystem } = await import(require.resolve("@effect/platform-node"))
const { Cause, Effect, Exit, FileSystem } = await import(require.resolve("effect"))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "remove-"))
const empty = path.join(root, "empty")
const held = path.join(root, "held")
fs.mkdirSync(empty)
fs.mkdirSync(held)
fs.writeFileSync(path.join(held, "theirs"), "content")
const remove = (target, options) =>
  Effect.runPromiseExit(
    FileSystem.FileSystem.use((fileSystem) => fileSystem.remove(target, options)).pipe(
      Effect.provide(NodeFileSystem.layer)
    )
  )
for (const [name, target, options] of [
  ["empty directory, no options", empty, undefined],
  ["directory holding a file, no options", held, undefined],
  ["directory holding a file, recursive", held, { recursive: true }]
]) {
  const exit = await remove(target, options)
  console.log(
    JSON.stringify({
      case: name,
      removed: Exit.isSuccess(exit),
      reason: Exit.isFailure(exit) ? Cause.squash(exit.cause).reason._tag : null,
      theirsKept: fs.existsSync(path.join(held, "theirs"))
    })
  )
}
fs.rmSync(root, { recursive: true, force: true })
JS
