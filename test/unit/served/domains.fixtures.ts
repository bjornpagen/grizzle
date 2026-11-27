/**
 * What the property of domains.test.ts reads: its box of refined text types and contracts, the places that name them,
 * the reads of them a served program makes, and the compiles it checks.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter } from "effect"
import { compileServed } from "#adapter/public/compile.ts"
import { builtLogin } from "#adapter/served/login.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { fieldColumnType } from "#compiler/ir/physical.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Fn, Type } from "#compiler/public/compute.ts"
import { contract, pg } from "#compiler/public/fields.ts"
import { param, query, v } from "#compiler/public/query.ts"
import { derived, fn, mutable, relation, row, rows, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { rostersOf } from "#compiler/schema/own.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { succeeded } from "#test/support/assert.ts"
import { compiledInstallation, compiledSnapshot } from "#test/support/compiled-served.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * The refined text types of the box: an alternation of words, the shape of an enum's roster spelled as a pattern; a
 * character class of a bounded repeat; and a pattern under a byte bound, whose language is the pattern's within it.
 */
const refinements = {
	"an alternation": str.regex("^(alpha|beta)$", "u"),
	"a character class": str.regex("^[a-z]{1,8}$", "u"),
	"a byte-bounded pattern": str.bytes(12, str.regex("^[a-z]+$", "u"))
} as const

/** The box's refinements by name. */
const refinementNames = ["an alternation", "a character class", "a byte-bounded pattern"] as const

export type Refinement = (typeof refinementNames)[number]

/** The places a case names the refinement and the contract at. */
const placements = ["a function's result alone", "a stored field too"] as const

/**
 * Where the case's refinement is named: by the functions' results alone, or by a stored field too, the installation's
 * domain of it the field's (the control, which compiled before).
 */
export type Placement = (typeof placements)[number]

/**
 * How a served program reads the refinement: a derived relation's fields, its stored definition reading a declared
 * function's rows and finding none of their fields, so only the definition's call casts to the refinement's domain; a
 * declared function's rows a query finds (Fn.rows); a field of rows of a
 * function's one row (Fn.row); a function's value (Fn.call); a function's rows a ChangeSet's shared sub-query reads in a
 * stratum realized one statement after another, which a carrier holds; and r.tokens' token, grizzle's own token
 * pattern, which no declaration names, found and carried.
 */
const reads = [
	"a derived relation over a function's rows found",
	"a function's rows found",
	"a field of a function's row found",
	"a function's value found",
	"a function's contract value found",
	"a query's own contract found",
	"a function's rows carried",
	"a text's tokens found",
	"a text's tokens carried"
] as const

export type Read = (typeof reads)[number]

export interface TextDomainCase {
	readonly refinement: Refinement
	readonly place: Placement
	readonly read: Read
}

export const caseGen: Gen<TextDomainCase> = (source) => ({
	refinement: source.draw(element(refinementNames)),
	place: source.draw(element(placements)),
	read: source.draw(element(reads))
})

/**
 * A word a carrying ChangeSet writes into Out, a code of the refinement or a token of a list, and a document's list:
 * any text of at most 64 bytes, so a B-tree entry of Out's key holds it, where a text no byte bound proves is refused
 * as a key (no code a refinement admits passes 12 bytes, the byte-bounded pattern's bound, and no case writes a list),
 * and each token of a list, of grizzle's token pattern within those bytes, is a word. A carrying delete binds one
 * variable to a token and to Out's value, which takes the type of the two that guarantees the other and is refused
 * where neither does (check/checker.ts RuleCheck #settle, 31664c74c6), as a token of a list of no byte bound and a
 * word are: a word holds whitespace, the token more than 64 bytes.
 */
const Word = str.bytes(64, str.regex("^.*$", "su"))

const countKey = Symbol("Count")
/** A contract the functions' results carry: grizzle's exact integer of QTI's range, edullm's QtiInteger. */
const Count = contract<typeof countKey>()("Count", pg.numeric(613, 0))

const rankKey = Symbol("Rank")
/** A contract only a query declares, the target of its checked cast. */
const Rank = contract<typeof rankKey>()("Rank", pg.integer)

/**
 * The case's login: Item(item), the items a function is called at; Doc(doc, list), lists of tokens; Out(item, value),
 * what a carrying ChangeSet writes, mutable inside the unit of its item, which its deletes need; Coded(item, code, count), a stored field of the refinement and one of the contract
 * where the case places them; and four functions whose results are of the refinement or the contract, `judge` returning
 * rows of (code, count), whose count no read finds but every read's cast checks, `judgeRow` one row of a field of such
 * rows, `judgeOne` a value of the refinement and `countOne` one of the contract, each body returning a member, each
 * function whose result holds Count declared under Count's key, since its body makes Count's values.
 */
const loginOf = (c: TextDomainCase) => {
	const R = refinements[c.refinement]
	const Item = relation("Item", { item: pg.integer }, ["item"])
	const Doc = relation("Doc", { doc: pg.integer, list: Word }, ["doc"])
	const Out = relation("Out", { item: pg.integer, value: Word }, ["item", "value"])
	const Coded = relation("Coded", { item: pg.integer, code: R, count: Count }, ["item"])
	const Judged = rows({ code: R, count: Count })
	/** Each body returns a member of the refinement, alpha or beta for the alternation and ab or cd for the others. */
	const words = c.refinement === "an alternation"
	const judge = fn(
		"judge",
		{
			calls: [],
			args: { item: pg.integer },
			returns: Judged,
			volatility: "immutable",
			nullInput: "called",
			language: "sql",
			body: words
				? fn.body`SELECT CASE WHEN item % 2 = 0 THEN 'alpha' ELSE 'beta' END, item::numeric`
				: fn.body`SELECT CASE WHEN item % 2 = 0 THEN 'ab' ELSE 'cd' END, item::numeric`
		},
		{ Count: countKey }
	)
	const judgeRow = fn(
		"judgeRow",
		{
			calls: [],
			args: { item: pg.integer },
			returns: row(rows({ codes: Judged })),
			volatility: "immutable",
			nullInput: "called",
			language: "sql",
			body: words
				? fn.body`SELECT ARRAY[ROW(CASE WHEN item % 2 = 0 THEN 'alpha' ELSE 'beta' END, item::numeric)::${Judged}]`
				: fn.body`SELECT ARRAY[ROW(CASE WHEN item % 2 = 0 THEN 'ab' ELSE 'cd' END, item::numeric)::${Judged}]`
		},
		{ Count: countKey }
	)
	const judgeOne = fn("judgeOne", {
		calls: [],
		args: { item: pg.integer },
		returns: R,
		volatility: "immutable",
		nullInput: "called",
		language: "sql",
		body: words
			? fn.body`SELECT CASE WHEN item % 2 = 0 THEN 'alpha' ELSE 'beta' END`
			: fn.body`SELECT CASE WHEN item % 2 = 0 THEN 'ab' ELSE 'cd' END`
	})
	const countOne = fn(
		"countOne",
		{
			calls: [],
			args: { item: pg.integer },
			returns: Count,
			volatility: "immutable",
			nullInput: "called",
			language: "sql",
			body: fn.body`SELECT item::numeric`
		},
		{ Count: countKey }
	)
	const base = schema(
		"TextDomains",
		[
			Item,
			Doc,
			Out,
			...(c.place === "a stored field too" ? [Coded] : []),
			judge,
			judgeRow,
			judgeOne,
			countOne
		],
		[unit("Items", { item: pg.integer }), mutable(Out)]
	)
	/**
	 * The items whose codes `judge` gives, a stored definition of its rows that finds none of their fields, in the unit
	 * Items every relation keyed by the item sits in.
	 */
	const Judging = derived(
		"Judging",
		query(base).rule((r) => {
			const { item: at } = v(Item, "item")
			const run = Fn.rows(judge, { item: at })
			const { code } = v(run, "run")
			return r.match(Item, { item: at }).match(run, { code }).find({ item: at })
		})
	)
	const s = schema.extend([base], "TextDomainsTop", [Judging], [])
	const item = param("item", pg.integer)
	/** The codes `judge` gives the item a parameter names. */
	const codes = query(s).rule((r) => {
		const run = Fn.rows(judge, { item: r.param("item", pg.integer) })
		const { code } = v(run, "run")
		return r.match(run, { code }).find({ code })
	})
	/** The tokens of the document a parameter names. */
	const tokens = query(s).rule((r) => {
		const { list } = v(Doc, "doc")
		const split = r.tokens(list)
		const { token } = v(split, "token")
		return r
			.match(Doc, { doc: r.param("doc", pg.integer), list })
			.match(split, { token })
			.find({ token })
	})
	/**
	 * ChangeSets that delete from Out the facts the item a parameter names gives (its codes, or the tokens of the
	 * document of its number) and insert them again: both members read one bound query, in a stratum that writes one
	 * relation twice, realized one statement after another, so the query is a shared sub-query a carrier holds.
	 */
	const codesCarried = ChangeSet.empty(s)
		.delete(
			Out,
			query(s).rule((r) => {
				const bound = codes.bind({ item })
				const { code } = v(bound, "code")
				return r
					.match(bound, { code })
					.match(Out, { item, value: code })
					.find({ item, value: code })
			})
		)
		.insert(
			Out,
			query(s).rule((r) => {
				const bound = codes.bind({ item })
				const { code } = v(bound, "code")
				return r.match(bound, { code }).find({ item, value: code })
			})
		)
	const tokensCarried = ChangeSet.empty(s)
		.delete(
			Out,
			query(s).rule((r) => {
				const bound = tokens.bind({ doc: item })
				const { token } = v(bound, "token")
				return r
					.match(bound, { token })
					.match(Out, { item, value: token })
					.find({ item, value: token })
			})
		)
		.insert(
			Out,
			query(s).rule((r) => {
				const bound = tokens.bind({ doc: item })
				const { token } = v(bound, "token")
				return r.match(bound, { token }).find({ item, value: token })
			})
		)
	const programs = {
		read: ((): unknown => {
			switch (c.read) {
				case "a derived relation over a function's rows found":
					return query(s).rule((r) => {
						const { item: at } = v(Judging, "judging")
						return r.match(Judging, { item: at }).find({ item: at })
					})
				case "a function's rows found":
					return codes
				case "a field of a function's row found":
					return query(s).rule((r) => {
						const read = Fn.row(judgeRow, { item: r.param("item", pg.integer) }).codes
						const { code } = v(read, "read")
						return r.match(read, { code }).find({ code })
					})
				case "a function's value found":
					return query(s).rule((r) => {
						const { item: at } = v(Item, "item")
						return r.match(Item, { item: at }).find({ code: Fn.call(judgeOne, { item: at }) })
					})
				case "a query's own contract found":
					return query(s).rule((r) => {
						const { item: at } = v(Item, "item")
						return r.match(Item, { item: at }).find({ rank: Type.cast(at, Rank, rankKey) })
					})
				case "a function's contract value found":
					return query(s).rule((r) => {
						const { item: at } = v(Item, "item")
						return r.match(Item, { item: at }).find({ count: Fn.call(countOne, { item: at }) })
					})
				case "a function's rows carried":
					return codesCarried
				case "a text's tokens found":
					return tokens
				case "a text's tokens carried":
					return tokensCarried
			}
		})()
	}
	return fullWorld(s, programs, []).server
}

/**
 * What a case's compile shows: its served file compiles, as generate compiles it, the installation over it with it, and
 * again under its snapshot as a Db does, each naming a domain only where its installation's set holds it (an
 * UninstalledDomain refusal otherwise), so every domain the case's statements name is one the installation creates;
 * every row type a function's signature installs holds each value field at its base, no domain, `text` for a refined text
 * and the contract's base for a contract, its refinement checked where a read casts the call's value to its domain; and
 * no role holds USAGE on a domain. It answers whether the case's ChangeSet carries a field of such a domain.
 */
export const checkCase = (c: TextDomainCase) =>
	Effect.gen(function* () {
		const login = loginOf(c)
		const built = defined(builtLogin(login), "the case's login")
		const owned = succeeded(built.base.content.owned(), "the case's base")
		const codes = firstCodebook(rostersOf(owned))
		const { installation, plan } = yield* compiledInstallation(built, owned, codes)
		const snapshot = yield* compiledSnapshot(built, owned, codes)
		yield* compileServed(login, snapshot, [...built.workload])
		const domains = new Set(
			Arr.flatMap(installation.statements, (st) =>
				st.kind === "createDomain" ? [st.name.name] : []
			)
		)
		for (const st of installation.statements) {
			if (st.kind === "createRowType") {
				for (const a of st.attributes) {
					assert.ok(
						a.type.kind !== "named" || !domains.has(a.type.name),
						`a function's row type holds ${a.name} at its base, no domain: ${printStatement(st)}\n${Formatter.format(c)}`
					)
				}
			}
		}
		const usage = Arr.flatMap(installation.statements, (st) =>
			st.kind === "grant" && st.on.kind === "DOMAIN" && Arr.contains(st.privileges, "USAGE")
				? Arr.map(st.on.names, (n) => n.name)
				: []
		)
		assert.deepEqual(usage, [], `no role holds USAGE on a domain\n${Formatter.format(c)}`)
		const carried = Arr.flatMap(plan.carriers, (r) =>
			Arr.flatMap(r.columns, (col) => {
				const type = fieldColumnType(installation.names, col.type).type
				return type.kind === "named" ? [type.name] : []
			})
		)
		return { carried: carried.length > 0 }
	})
