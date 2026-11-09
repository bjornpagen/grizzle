#!/bin/sh
# Writes the reproduction project to a fresh temporary directory, installs the given arkregex and TypeScript releases
# from npm and type-checks it: `sh repro.sh <arkregex version> <typescript version>`. Each U+200B line states what a
# correct inference gives and fails today. Each U+200C line is the same pattern with a character ArkRegex does not use
# as a marker, and passes. `control` states a wrong inference: the one error a fixed release reports. tsc's output has
# each U+200B and U+200C written as an escape, since both are invisible.
set -eu
arkregex="$1"
typescript="$2"
dir="$(mktemp -d)"
cat > "$dir/package.json" <<'JSON'
{ "name": "repro", "private": true, "type": "module" }
JSON
cat > "$dir/tsconfig.json" <<'JSON'
{
	"compilerOptions": {
		"target": "esnext",
		"module": "nodenext",
		"strict": true,
		"noEmit": true,
		"skipLibCheck": true
	},
	"files": ["repro.ts"]
}
JSON
cat > "$dir/repro.ts" <<'TS'
import { regex } from "arkregex"

// true when t is exactly u, else t itself, so a mismatch names the inferred type
type Exact<t, u> = [t] extends [u] ? ([u] extends [t] ? true : t) : t

// A source ending in U+200B: read as an error message, so the call is typed as its source string
const end = regex("a\u200B")
export const endExact: Exact<typeof end.infer, `${string}a\u200B${string}`> = true
const alternative = regex("x|\u200B")
export const alternativeExact: Exact<
	typeof alternative.infer,
	`${string}x${string}` | `${string}\u200B${string}`
> = true

// U+200B in a class: read as an error ending the class, so the class's other members are dropped
const before = regex("^[a\u200B]b$")
export const beforeExact: Exact<typeof before.infer, "ab" | "\u200Bb"> = true
const after = regex("^[\u200Ba]b$")
export const afterExact: Exact<typeof after.infer, "ab" | "\u200Bb"> = true

// U+200B on both sides of a literal ^ or $: read as an anchor marker, so the pattern is refused or widened to string
const caret = regex("^a<\u200B\\^\u200B>b$")
export const caretExact: Exact<typeof caret.infer, "a<\u200B^\u200B>b"> = true
const dollar = regex("<\u200B\\$\u200B>")
export const dollarExact: Exact<typeof dollar.infer, `${string}<\u200B$\u200B>${string}`> = true

// The same patterns with U+200C: each inferred exactly
const endControl = regex("a\u200C")
export const endControlExact: Exact<typeof endControl.infer, `${string}a\u200C${string}`> = true
const alternativeControl = regex("x|\u200C")
export const alternativeControlExact: Exact<
	typeof alternativeControl.infer,
	`${string}x${string}` | `${string}\u200C${string}`
> = true
const beforeControl = regex("^[a\u200C]b$")
export const beforeControlExact: Exact<typeof beforeControl.infer, "ab" | "\u200Cb"> = true
const afterControl = regex("^[\u200Ca]b$")
export const afterControlExact: Exact<typeof afterControl.infer, "ab" | "\u200Cb"> = true
const caretControl = regex("^a<\u200C\\^\u200C>b$")
export const caretControlExact: Exact<typeof caretControl.infer, "a<\u200C^\u200C>b"> = true
const dollarControl = regex("<\u200C\\$\u200C>")
export const dollarControlExact: Exact<
	typeof dollarControl.infer,
	`${string}<\u200C$\u200C>${string}`
> = true

export const control: Exact<typeof endControl.infer, "a\u200C"> = true
TS
cd "$dir"
npm install --silent --no-audit --no-fund "arkregex@$arkregex" "typescript@$typescript" > /dev/null
echo "arkregex $(node -p 'require("./node_modules/arkregex/package.json").version'), typescript $(node_modules/.bin/tsc --version)"
node_modules/.bin/tsc -p tsconfig.json | node -e '
let s = ""
process.stdin.on("data", (c) => { s += c })
process.stdin.on("end", () => process.stdout.write(s.replace(/\u200B/g, "\\u200B").replace(/\u200C/g, "\\u200C")))
' || true
rm -rf "$dir"
