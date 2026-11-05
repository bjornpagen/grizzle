#!/bin/sh
# grizzle-mutate, the mutation tester's command for a package that has @grizzle/testing in its node_modules: it runs
# scripts/mutate.ts with every argument it is given. Node strips no types from a file under node_modules, and the
# library ships TypeScript source, so Node first imports a load hook, from a data: URL, that strips the types of every
# TypeScript module under node_modules as Node would anywhere else, and leaves every other module to Node; the run then
# loads as it does in the library's own checkout. Node calls the stripping it lends experimental, so its warning is off.
set -eu
here=$(dirname -- "$(realpath -- "$0")")
strip='import { readFileSync } from "node:fs"; import { registerHooks, stripTypeScriptTypes } from "node:module"; registerHooks({ load: (url, context, nextLoad) => url.includes("/node_modules/") && url.endsWith(".ts") ? { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")), shortCircuit: true } : nextLoad(url, context) });'
exec node --disable-warning=ExperimentalWarning --import "data:text/javascript,$strip" "$here/mutate.ts" "$@"
