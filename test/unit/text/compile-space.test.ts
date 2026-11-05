import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, string } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { RegexSpaceMeasure } from "#compiler/core/errors.ts"
import {
	regexMaxAnchors,
	regexMaxAnchorWeight,
	regexMaxClosurePairs,
	regexMaxPositions
} from "#compiler/core/limits.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, assertVariant, refused, succeeded } from "#test/support/assert.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
import { caseHang } from "#test/support/limits.ts"
import { jsAccepts } from "#test/unit/text/generators.ts"

/**
 * The compile-space measures (core/limits.ts regexMaxPositions, regexMaxClosurePairs, regexMaxAnchors,
 * regexMaxAnchorWeight), which stand for PostgreSQL's REG_MAX_COMPILE_SPACE: a pattern past one is refused as
 * ResourceBound with the measure it crossed, at any nesting depth, and no count of constructs refuses anything, so the
 * strict RFC 3986 URI-reference grammar, written out as one pattern, is admitted. That PostgreSQL compiles what the
 * measures admit is test/pg/text/differential.test.ts's.
 */
const loc = SourceLoc("str.regex", ["Web", "relations", "Link", "fields", "href"])

/** A chain of `+` groups and a chain of optional groups around one literal, 100,000 levels deep. */
const depth = 100_000
const plusChain = `${Str.repeat(depth)("(?:")}a${Str.repeat(depth)(")+")}`
const optionalChain = `${Str.repeat(depth)("(?:a")}${Str.repeat(depth)(")?")}`

type Planted = RegexSpaceMeasure["kind"]

/** A pattern just past each measure, and the measure it is refused for. */
const planted: Arr.NonEmptyReadonlyArray<readonly [string, RegexSpaceMeasure]> = [
	[
		"^(?:[a-z]{1,255}){17}$",
		{ kind: "positions", limit: regexMaxPositions.value, needed: 17 * 255 + 2 }
	],
	[optionalChain, { kind: "positions", limit: regexMaxPositions.value, needed: depth }],
	["(?:$|a|){9}b", { kind: "anchors", limit: regexMaxAnchors.value, needed: 9 }],
	[
		"(?:$|a|){4}(?:^|a|){4}(?:[a-z]{255}){4}b",
		{
			kind: "anchorWeight",
			limit: regexMaxAnchorWeight.value,
			anchors: 8,
			positions: 8 * 2 + 4 * 255 + 1
		}
	],
	["(?:a?){255}(?:b?){255}c", { kind: "closurePairs", limit: regexMaxClosurePairs.value }],
	[plusChain, { kind: "closurePairs", limit: regexMaxClosurePairs.value }],
	["(?:(?:[a-z]{255}){65}|$)*b", { kind: "anchorLoop" }]
]

describe("the compile-space measures", () => {
	it.effect(
		"refuses a pattern past each measure as ResourceBound with that measure, 100,000 levels deep included",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/text/compile-space",
						literal: Formatter.format,
						generator: element(planted),
						limit: planted.length,
						coverage: requiredInSpace<Planted>([
							"positions",
							"anchors",
							"anchorWeight",
							"closurePairs",
							"anchorLoop"
						]),
						caseHang
					},
					([source, measure], n) =>
						Effect.sync(() => {
							n.note(measure.kind)
							const { reason } = refused(
								analyzeText(source, "u", loc),
								"ResourceBound",
								measure.kind
							)
							assertVariant(reason, "_tag", "ResourceBound", measure.kind)
							assert.deepEqual(
								reason.bound,
								{ kind: "regexCompileSpace", pattern: `/${source}/u`, measure },
								measure.kind
							)
						})
				)
			)
	)
})

/**
 * The strict URI-reference grammar of RFC 3986 Appendix A, each rule spelled as the pattern of its ABNF and composed
 * into one pattern: about 6,200 code points, 1,569 NFA positions written out, two anchors and 3,169 pairs of states
 * joined by empty paths, inside every compile-space measure. ABNF's quoted strings are case-insensitive, so HEXDIG is
 * either case and IPvFuture's "v" is `[vV]`.
 */
const hexdig = "[0-9A-Fa-f]"
const unreserved = "[A-Za-z0-9\\-._~]"
const subDelims = "[!$&'()*+,;=]"
const pctEncoded = `%${hexdig}${hexdig}`
const pchar = `(?:${unreserved}|${pctEncoded}|${subDelims}|:|@)`
const segment = `${pchar}*`
const segmentNz = `${pchar}+`
const segmentNzNc = `(?:${unreserved}|${pctEncoded}|${subDelims}|@)+`
const pathAbempty = `(?:/${segment})*`
const pathAbsolute = `/(?:${segmentNz}(?:/${segment})*)?`
const pathNoscheme = `${segmentNzNc}(?:/${segment})*`
const pathRootless = `${segmentNz}(?:/${segment})*`
const pathEmpty = ""
const query = `(?:${pchar}|/|\\?)*`
const fragment = `(?:${pchar}|/|\\?)*`
const decOctet = "(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])"
const ipv4address = `${decOctet}\\.${decOctet}\\.${decOctet}\\.${decOctet}`
const h16 = `${hexdig}{1,4}`
const ls32 = `(?:${h16}:${h16}|${ipv4address})`
const ipv6address = Arr.join(
	[
		`(?:${h16}:){6}${ls32}`,
		`::(?:${h16}:){5}${ls32}`,
		`(?:${h16})?::(?:${h16}:){4}${ls32}`,
		`(?:(?:${h16}:){0,1}${h16})?::(?:${h16}:){3}${ls32}`,
		`(?:(?:${h16}:){0,2}${h16})?::(?:${h16}:){2}${ls32}`,
		`(?:(?:${h16}:){0,3}${h16})?::${h16}:${ls32}`,
		`(?:(?:${h16}:){0,4}${h16})?::${ls32}`,
		`(?:(?:${h16}:){0,5}${h16})?::${h16}`,
		`(?:(?:${h16}:){0,6}${h16})?::`
	],
	"|"
)
const ipvFuture = `[vV]${hexdig}+\\.(?:${unreserved}|${subDelims}|:)+`
const ipLiteral = `\\[(?:${ipv6address}|${ipvFuture})\\]`
const regName = `(?:${unreserved}|${pctEncoded}|${subDelims})*`
const host = `(?:${ipLiteral}|${ipv4address}|${regName})`
const port = "[0-9]*"
const userinfo = `(?:${unreserved}|${pctEncoded}|${subDelims}|:)*`
const authority = `(?:${userinfo}@)?${host}(?::${port})?`
const scheme = "[A-Za-z][A-Za-z0-9+\\-.]*"
const hierPart = `(?://${authority}${pathAbempty}|${pathAbsolute}|${pathRootless}|${pathEmpty})`
const relativePart = `(?://${authority}${pathAbempty}|${pathAbsolute}|${pathNoscheme}|${pathEmpty})`
const uri = `${scheme}:${hierPart}(?:\\?${query})?(?:#${fragment})?`
const relativeRef = `${relativePart}(?:\\?${query})?(?:#${fragment})?`
const uriReference = `^(?:${uri}|${relativeRef})$`

/** Every example URI and every reference of RFC 3986 sections 1.1.2 and 5.4, each a URI-reference. */
const examples: Arr.NonEmptyReadonlyArray<string> = [
	"ftp://ftp.is.co.za/rfc/rfc1808.txt",
	"http://www.ietf.org/rfc/rfc2396.txt",
	"ldap://[2001:db8::7]/c=GB?objectClass?one",
	"mailto:John.Doe@example.com",
	"news:comp.infosystems.www.servers.unix",
	"tel:+1-816-555-1212",
	"telnet://192.0.2.16:80/",
	"urn:oasis:names:specification:docbook:dtd:xml:4.1.2",
	"foo://example.com:8042/over/there?name=ferret#nose",
	"http://a/b/c/d;p?q",
	"g:h",
	"g",
	"./g",
	"g/",
	"/g",
	"//g",
	"?y",
	"g?y",
	"#s",
	"g#s",
	"g?y#s",
	";x",
	"g;x",
	"g;x?y#s",
	"",
	".",
	"./",
	"..",
	"../",
	"../g",
	"../..",
	"../../",
	"../../g",
	"../../../g",
	"/./g",
	"/../g",
	"g.",
	".g",
	"g..",
	"..g",
	"./../g",
	"./g/.",
	"g/./h",
	"g/../h",
	"g;x=1/./y",
	"g;x=1/../y",
	"g?y/./x",
	"g#s/../x",
	"http:g"
]

/** The code points a URI-reference is spelled in, the delimiters that make one malformed, and percent signs. */
const uriAlphabet = "aZ09-._~!$&'()*+,;=:@/?#[]%vF "

describe("the RFC 3986 URI-reference grammar as one pattern", () => {
	it.effect("is admitted, and accepts every example URI and reference of RFC 3986", (ctx) => {
		const refinement = succeeded(analyzeText(uriReference, "u", loc), "the grammar")
		return searched(
			ctx,
			exhaust(
				{
					suite: "unit/text/rfc3986-examples",
					literal: Formatter.format,
					generator: element(examples),
					limit: examples.length,
					coverage: requiredInSpace<"an example">(["an example"]),
					caseHang
				},
				(example, n) =>
					Effect.sync(() => {
						n.note("an example")
						assert.equal(accepts(refinement, example), true, example)
					})
			)
		)
	})

	type Membership = "a member" | "no member"
	it.effect(
		"accepts exactly the strings ECMAScript's RegExp accepts, on strings over its alphabet",
		(ctx) => {
			const refinement = succeeded(analyzeText(uriReference, "u", loc), "the grammar")
			return searched(
				ctx,
				explore(
					{
						suite: "unit/text/rfc3986-membership",
						draw: drawn(
							array(string(element(Str.split(uriAlphabet, "")), { min: 0, max: 4 }), {
								min: 0,
								max: 6
							})
						),
						literal: Formatter.format,
						coverage: required<Membership>(["a member", "no member"], {
							cases: 2000,
							sense: notesOnly
						}),
						kept: [],
						runs: 2000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(parts, n) =>
						Effect.sync(() => {
							const value = Arr.join(parts, "")
							const member = jsAccepts(uriReference, "u", value)
							n.note(member ? "a member" : "no member")
							assert.equal(accepts(refinement, value), member, value)
						})
				)
			)
		}
	)
})
