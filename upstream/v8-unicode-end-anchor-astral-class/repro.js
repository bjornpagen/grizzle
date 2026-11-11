// A unicode-mode RegExp that ends in `$`, does not start with `^`, and holds a bracketed class naming a code point past
// U+FFFF by an escape, misses a match V8 finds everywhere else. Run with plain node: `node repro.js`. Each line is a
// case: the pattern, the subject, what ECMA-262 says `test` answers, and what this engine answers. The exit status is
// 1 while any case disagrees, 0 once every case agrees.
"use strict"

const astral = String.fromCodePoint(0x1f600)
const top = String.fromCodePoint(0x10ffff)

/** One case: its source, its flags, its subject and ECMA-262's answer. */
const cases = [
	["the report: an astral class, then $", String.raw`[\u{10000}-\u{10FFFF}]$`, "u", astral, true],
	["the same at U+10FFFF", String.raw`[\u{10000}-\u{10FFFF}]$`, "u", top, true],
	["one astral code point in the class", String.raw`[\u{1F600}]$`, "u", astral, true],
	["a BMP member beside it", String.raw`[a\u{1F600}]$`, "u", astral, true],
	["a negated class", String.raw`[^a]$`, "u", astral, true],
	["one code unit before it", String.raw`[\u{10000}-\u{10FFFF}]$`, "u", `x${astral}`, true],
	["a literal before the class", String.raw`a[\u{10000}-\u{10FFFF}]$`, "u", `a${astral}`, true],
	["the class twice", String.raw`[\u{10000}-\u{10FFFF}]{2}$`, "u", astral + astral, true],
	["control: anchored at the start", String.raw`^[\u{10000}-\u{10FFFF}]$`, "u", astral, true],
	["control: the v flag", String.raw`[\u{10000}-\u{10FFFF}]$`, "v", astral, true],
	["control: no $", String.raw`[\u{10000}-\u{10FFFF}]`, "u", astral, true],
	["control: sticky", String.raw`[\u{10000}-\u{10FFFF}]$`, "uy", astral, true],
	["control: an atom, not a class", String.raw`\u{1F600}$`, "u", astral, true],
	["control: dot", String.raw`.$`, "u", astral, true],
	["control: a longest match longer than the subject", String.raw`[\u{10000}-\u{10FFFF}]a{0,1022}$`, "u", astral, true],
	[
		"control: the class's code points in the source itself, a two-byte pattern",
		`[${String.fromCodePoint(0x10000)}-${top}]$`,
		"u",
		astral,
		true
	],
	["control: a BMP class", String.raw`[\u{100}-\u{FFFF}]$`, "u", String.fromCodePoint(0x1234), true],
	["control: no match where none exists", String.raw`[\u{10000}-\u{10FFFF}]$`, "u", "ab", false]
]

let disagreements = 0
for (const [what, source, flags, subject, expected] of cases) {
	const actual = new RegExp(source, flags).test(subject)
	const agrees = actual === expected
	if (!agrees) {
		disagreements += 1
	}
	const shown = [...subject].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`).join(" ")
	console.log(
		`${agrees ? "ok  " : "BUG "} /${source}/${flags}.test(${shown}) expected ${expected}, got ${actual}  (${what})`
	)
}
console.log(`node ${process.version}, V8 ${process.versions.v8}: ${disagreements} case(s) disagree`)
process.exitCode = disagreements === 0 ? 0 : 1
