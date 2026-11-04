import { Array as Arr, pipe, String as Str } from "effect"
import { defined } from "#test/support/assert.ts"
import { indices } from "#test/support/oracle/pick.ts"
import type { BudgetEntries } from "#test/types/query/budget/generate.ts"

/**
 * The growing regex schema: one type test of regex inference at scale.
 *
 * `regexSchemaSource(n)` writes one TypeScript program over the public types with n distinct str.regex patterns, ten
 * text fields to a relation, and for every relation the places a pattern's inferred host type flows into:
 * `Infer<typeof F>`, `Fact<R>`, the typed parameter a query infers from a comparison against a field,
 * and the result fields of a query that projects the fields unchanged. It asserts the exact inferred type of every
 * pattern and of every relation's fact, parameters and head, so the program stops typechecking at any size where
 * inference widens or collapses, not only where the checker gives up. Its refusals carry
 * `@ts-expect-error -- TSnnnn` directives, which the type tests disarm to check that each fires with the code it names.
 *
 * The patterns cycle through the typed-authoring shapes: finite alternatives inferring a literal union, digit
 * templates, anchored and unanchored literals inferring `${string}` templates, wide classes inferring string, a dot
 * under "su", and a source longer than the typed-authoring scan budget (packages/engine/src/types/fields/source.ts), which
 * widens to string by design rather than failing.
 *
 * The patterns of the program the type-test batch checks.
 */
export const regexSchemaPatterns = 300

/** What the host type admits: narrower than string, with a value outside it that the type refuses, or string itself. */
type Domain = { readonly kind: "narrow"; readonly outside: string } | { readonly kind: "wide" }

interface RegexPattern {
	readonly source: string
	readonly flags: "u" | "su"
	/** The host type the inference must produce, as TypeScript type text. */
	readonly host: string
	/** A value the pattern accepts, which must inhabit the host type. */
	readonly member: string
	readonly domain: Domain
}

/** A typed-authoring shape, by name, and its i-th pattern. */
interface Shape {
	readonly name: "finite" | "digits" | "prefix" | "infix" | "class" | "dotAll" | "long" | "version"
	readonly pattern: (i: number) => RegexPattern
}

const narrow = (outside: string): Domain => ({ kind: "narrow", outside })
const wide: Domain = { kind: "wide" }

/** The shapes the patterns cycle through, in order. */
const shapes: Arr.NonEmptyReadonlyArray<Shape> = [
	{
		name: "finite",
		pattern: (i) => ({
			source: `^(?:k${i}a|k${i}b)$`,
			flags: "u",
			host: `"k${i}a" | "k${i}b"`,
			member: `k${i}b`,
			domain: narrow("x")
		})
	},
	{
		name: "digits",
		pattern: (i) => ({
			source: `^t${i}-\\d+$`,
			flags: "u",
			host: `\`t${i}-\${number}\``,
			member: `t${i}-42`,
			domain: narrow(`t${i}-`)
		})
	},
	{
		name: "prefix",
		pattern: (i) => ({
			source: `^p${i}:`,
			flags: "u",
			host: `\`p${i}:\${string}\``,
			member: `p${i}:x`,
			domain: narrow(`q${i}:`)
		})
	},
	{
		name: "infix",
		pattern: (i) => ({
			source: `c${i}x`,
			flags: "u",
			host: `\`\${string}c${i}x\${string}\``,
			member: `-c${i}x-`,
			domain: narrow(`c${i}`)
		})
	},
	{
		name: "class",
		pattern: (i) => ({
			source: `^[a-z][a-z0-9-]*-w${i}$`,
			flags: "u",
			host: "string",
			member: `ab1-w${i}`,
			domain: wide
		})
	},
	{
		name: "dotAll",
		pattern: (i) => ({
			source: `^s${i}.$`,
			flags: "su",
			host: `\`s${i}\${string}\``,
			member: `s${i}\n`,
			domain: narrow(`r${i}`)
		})
	},
	{
		/** Longer than the scan budget of 40 code units: inferred as string, and still validated by the compiler. */
		name: "long",
		pattern: (i) => ({
			source: `^(?:alpha|beta|gamma|delta|epsilon|zeta|l${i})$`,
			flags: "u",
			host: "string",
			member: `l${i}`,
			domain: wide
		})
	},
	{
		name: "version",
		pattern: (i) => ({
			source: `^v${i}\\.(\\d+)\\.(\\d+)$`,
			flags: "u",
			host: `\`v${i}.\${number}.\${number}\``,
			member: `v${i}.1.2`,
			domain: narrow(`v${i}.1`)
		})
	}
]

const shapeOf = (i: number): Shape =>
	defined(shapes[i % shapes.length], "the pattern index cycles through the shapes")

/**
 * The i-th pattern of the growing schema. Every pattern is distinct, admitted by the compiler's grammar, and
 * structurally different from its neighbors, so the program instantiates one inference per pattern.
 */
export const regexPattern = (i: number): RegexPattern => shapeOf(i).pattern(i)

const fieldsPerRelation = 10

/**
 * A TypeScript string literal for `value`. JSON leaves U+2028 and U+2029 raw, and TypeScript counts each as a line
 * break, which would shift every later diagnostic line; they are escaped.
 */
export const literal = (value: string): string =>
	Str.replaceAll(
		"\u2029",
		"\\u2029"
	)(pipe(JSON.stringify(value), Str.replaceAll("\u2028", "\\u2028")))

/** A relation's declaration over patterns [first, first + fieldsPerRelation). */
const relationDeclaration = (r: number, count: number): string => {
	const fields = Arr.join(
		Arr.map(indices(count), (j) => `f${j}: P${r * fieldsPerRelation + j}`),
		", "
	)
	return `export const R${r} = relation("R${r}", { id: uuid, ${fields} }, ["id"])\n`
}

/**
 * A relation's queries: a comparison of its first text field with a parameter, projecting every field unchanged. The
 * parameters are bound through `ParamArg<ParamsOf<…>>`, the type a typed caller holds; the call then reads them as they
 * are.
 */
const relationQueries = (r: number, count: number): string => {
	const names = Arr.join(
		Arr.map(indices(count), (j) => `f${j}`),
		", "
	)
	return `export const byF${r} = query(S).rule((r) => {
	const { id, ${names} } = v(R${r}, "r${r}")
	return r.match(R${r}, { id, ${names} }).where(r.eq(f0, r.param("p", R${r}.fields.f0))).find({ id, ${names} })
})
export const params${r}: ParamArg<ParamsOf<typeof byF${r}>> = { p: ${literal(regexPattern(r * fieldsPerRelation).member)} }
export const run${r} = db.execute(byF${r}, params${r})
`
}

const hostOf = (i: number): string => regexPattern(i).host

/** Exact assertions over relation r: its fact, its parameters and its head, field by field. */
const relationAssertions = (r: number, count: number): string => {
	const head = Arr.map(
		indices(count),
		(j) => `readonly f${j}: ${hostOf(r * fieldsPerRelation + j)}`
	)
	return `export type Fact${r} = Expect<Equals<Fact<typeof R${r}>, { readonly id: Uuid; ${Arr.join(head, "; ")} }>>
export type Params${r} = Expect<Equals<ParamsOf<typeof byF${r}>, { readonly p: ParamType<string, "text", ${hostOf(r * fieldsPerRelation)}> }>>
export type Head${r} = Expect<Equals<HeadOf<typeof byF${r}>, { readonly id: Uuid; ${Arr.join(head, "; ")} }>>
`
}

/** The value a narrow pattern's host type refuses. */
const outsideOf = (p: RegexPattern): string => {
	if (p.domain.kind === "narrow") {
		return p.domain.outside
	}
	throw new Error(`${p.source} is a wide pattern: no value lies outside its host type`)
}

/** The last index below n that holds. */
const lastWhere = (n: number, holds: (i: number) => boolean): number => {
	for (let i = n - 1; i >= 0; i--) {
		if (holds(i)) {
			return i
		}
	}
	throw new Error(`no index below ${n} holds`)
}

/**
 * The refusals that must keep firing in the largest program, each a directive and the line it refuses: an
 * out-of-pattern constant passed as a typed comparison parameter, a value outside a pattern's host, a malformed
 * pattern and a refused flag.
 */
const refusals = (patterns: number, relations: number): ReadonlyArray<string> => {
	/**
	 * The last relation whose first field is a finite pattern, and the last pattern of the version shape, whose host
	 * is a template narrower than string.
	 */
	const finiteRelation = lastWhere(
		relations,
		(r) => shapeOf(r * fieldsPerRelation).name === "finite"
	)
	const version = lastWhere(patterns, (i) => shapeOf(i).name === "version")
	return [
		`// @ts-expect-error -- TS2322: an out-of-pattern constant is not the comparison parameter's host type
export const outOfPattern: ParamArg<ParamsOf<typeof byF${finiteRelation}>> = { p: ${literal(outsideOf(regexPattern(finiteRelation * fieldsPerRelation)))} }
`,
		`// @ts-expect-error -- TS2322: the value lies outside the pattern's inferred host type
export const outsideValue: Infer<typeof P${version}> = ${literal(outsideOf(regexPattern(version)))}
`,
		`// @ts-expect-error -- TS2345: an unterminated group is malformed
export const malformed = str.regex("^(k${patterns}a$")
`,
		`// @ts-expect-error -- TS2345: the i flag is not admitted
export const caseless = str.regex("^k${patterns}$", "i")
`
	]
}

/** The number of `@ts-expect-error` directives `regexSchemaSource` writes over `patterns` patterns. */
export const regexSchemaRefusalCount = (patterns: number): number =>
	refusals(patterns, patterns / fieldsPerRelation).length

/**
 * A complete program over `patterns` patterns that imports the public barrels and the declare-only Db type from
 * `entries`: relation, schema and role from the schema barrel, str from the text barrel, uuid from the fields barrel,
 * query and v from the query barrel.
 */
export const regexSchemaSource = (patterns: number, entries: BudgetEntries): string => {
	if (patterns < fieldsPerRelation || patterns % fieldsPerRelation !== 0) {
		throw new Error(`the pattern count must be a positive multiple of ${fieldsPerRelation}`)
	}
	const relations = patterns / fieldsPerRelation
	const declarations = Arr.join(
		Arr.map(indices(patterns), (i) => {
			const p = regexPattern(i)
			return `export const P${i} = str.regex(${literal(p.source)}, ${literal(p.flags)})
export type Host${i} = Expect<Equals<Infer<typeof P${i}>, ${p.host}>>
export const member${i}: Infer<typeof P${i}> = ${literal(p.member)}
`
		}),
		""
	)
	const rels = Arr.join(
		Arr.map(indices(relations), (r) => relationDeclaration(r, fieldsPerRelation)),
		""
	)
	const names = Arr.join(
		Arr.map(indices(relations), (r) => `R${r}`),
		", "
	)
	const queries = Arr.join(
		Arr.map(indices(relations), (r) => relationQueries(r, fieldsPerRelation)),
		""
	)
	const checks = Arr.join(
		Arr.map(indices(relations), (r) => relationAssertions(r, fieldsPerRelation)),
		""
	)
	return `// Generated by test/types/regex/schema.ts with ${patterns} patterns over ${relations} relations.
import type { DbOf } from ${JSON.stringify(entries.db)}
import { type Fact, relation, role, schema } from ${JSON.stringify(entries.schema)}
import { str } from ${JSON.stringify(entries.text)}
import { type Infer, type Uuid, uuid } from ${JSON.stringify(entries.fields)}
import { type HeadOf, type ParamArg, type ParamsOf, type ParamType, query, v } from ${JSON.stringify(entries.query)}

type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

${declarations}
${rels}
export const S = schema("Patterns", { ${names} }, [])
export const Reader = role(S, "reader", S.relations)
declare const db: DbOf<typeof Reader, unknown>
${queries}
${checks}
${Arr.join(refusals(patterns, relations), "")}`
}
