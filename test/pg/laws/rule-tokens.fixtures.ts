/** What the properties of rule-tokens.test.ts read: their schema and template, their spaces, and each case's run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Data, Effect, Formatter, Option, String as Str } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { bool, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, contained, derived, key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { readsOf, rerunsOf } from "#test/pg/laws/rule-whole.fixtures.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import {
	type Installed,
	migratedTemplate,
	noPlaceholders,
	seededTemplate
} from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { storedSeed } from "#test/support/stored.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { SubstrateTemplate } from "#test/support/substrate/substrate.ts"

/**
 * edullm's pantry in small: each element's attributes, keyed by the element, an IDREFS one `listed`, its `lexical` a
 * whitespace-separated list of IDREF tokens, and each document's targets, the ids its tokens may name. Idref is the
 * listed attributes' tokens (r.tokens), a derived relation no table stores, and three rules read it: every token names
 * a target of its document ("Idref target", pantry's law of that name), no token of an attribute twice ("Distinct
 * tokens", the key HTML's `headers` cells hold), and a list of three tokens at most ("Short list", QTI's tolerance of one
 * or two values). Every relation is immutable and keyed by its document first, so each rule is unit-local, judged whole
 * over the documents a transaction wrote.
 */
const Short = str.bytes(64, str.regex("^.*$", "su"))

const Attribute = relation(
	"Attribute",
	{ package: Short, path: Short, start: int4, lexical: Short, listed: bool },
	["package", "path", "start"]
)
const Target = relation("Target", { package: Short, path: Short, id: Short }, [
	"package",
	"path",
	"id"
])

const Base = schema("rule_tokens", [Attribute, Target], [])

/** The tokens of each listed attribute, at their places: a document's IDREF tokens. */
const Idref = derived(
	"Idref",
	query(Base).rule((r) => {
		const { package: pkg, path, start, lexical } = v(Attribute, "a")
		const { at, token } = v(r.tokens(lexical), "t")
		return r
			.match(Attribute, { package: pkg, path, start, lexical, listed: true })
			.match(r.tokens(lexical), { at, token })
			.find({ package: pkg, path, start, at, token })
	})
)

/** The longest list Short list admits, in tokens: its last token at place 2. */
const longest = 3

const tokensSchema = schema.extend(
	[Base],
	"rule_tokens_1",
	[Idref],
	[
		contained(on(Idref, "package", "path", "token"), on(Target, "package", "path", "id")),
		key(on(Idref, "package", "path", "start", "token")),
		check("Short_list", Idref, (t) => t.lt(t.at, BigInt(longest)))
	]
)

export const tokensTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "rule tokens",
	content: { schema: tokensSchema.name, logins: [] },
	versions: [{ schema: tokensSchema, declarations: noDeclarations }],
	options: {
		label: "rule_tokens",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** The tokens a list is drawn from, a document's ids among them: none holds XML whitespace. */
const alphabet = ["a", "b", "ab", "é"] as const

/** The XML whitespace characters (XML 1.0, S) a list's runs are drawn from. */
const spaces = [" ", "\t", "\n", "\r"] as const

/** A run of XML whitespace, one to three characters. */
const runGen: Gen<string> = (s) => Arr.join(s.draw(array(element(spaces), { min: 1, max: 3 })), "")

/** A whitespace-separated list as written: its tokens, its runs between them, and whitespace or none at either end. */
const listGen: Gen<string> = (s) => {
	const tokens = s.draw(array(element(alphabet), { min: 0, max: longest + 1 }))
	const lead = s.draw(
		weighted([
			[2, () => ""],
			[1, runGen]
		])
	)
	const trail = s.draw(
		weighted([
			[2, () => ""],
			[1, runGen]
		])
	)
	return `${lead}${Arr.join(
		Arr.map(tokens, (t, i) => (i === 0 ? t : `${s.draw(runGen)}${t}`)),
		""
	)}${trail}`
}

/** One attribute of a document: its start, its text, and whether it is a listed one, an IDREFS. */
export interface DrawnAttribute {
	readonly start: number
	readonly lexical: string
	readonly listed: boolean
}

/** One document a transaction writes whole: its attributes and its targets. */
export interface DrawnDocument {
	readonly path: string
	readonly attributes: ReadonlyArray<DrawnAttribute>
	readonly targets: ReadonlyArray<string>
}

/** A case of the equivalence: the documents one transaction writes, each a unit. */
export interface Written {
	readonly documents: Arr.NonEmptyReadonlyArray<DrawnDocument>
}

/**
 * A document of one to three attributes, its targets most often every token of the alphabet, so a list the split reads
 * as the specification does keeps Idref target, and otherwise a few of them, beside a text of a space or none, which a
 * token never is.
 */
const documentGen =
	(path: string): Gen<DrawnDocument> =>
	(s) => ({
		path,
		attributes: Arr.map(s.draw(array(listGen, { min: 1, max: 3 })), (lexical, start) => ({
			start,
			lexical,
			listed: s.draw(
				weighted([
					[4, () => true],
					[1, () => false]
				])
			)
		})),
		targets: s.draw(
			weighted([
				[3, () => [...alphabet]],
				[2, (t) => t.draw(array(element([...alphabet, " ", ""]), { min: 0, max: 4 }))]
			])
		)
	})

export const writtenGen: Gen<Written> = (s) => {
	const first = s.draw(documentGen("d0"))
	const more = s.draw(int(0, 1))
	return {
		documents: [first, ...Array.from({ length: more }, (_, i) => s.draw(documentGen(`d${i + 1}`)))]
	}
}

export type TokensFeature =
	| "accepted"
	| "refused by Idref target"
	| "refused by Distinct tokens"
	| "refused by Short list"
	| "a list of whitespace alone"
	| "a run of several whitespace characters"
	| "whitespace before the first token or after the last"
	| "a tab, LF or CR between two tokens"
	| "a list of exactly the longest length"
	| "two documents in one transaction"

/** The rules the schema states, by the names their features read. */
type RuleName = "Idref target" | "Distinct tokens" | "Short list"

/** A run of XML whitespace (XML 1.0, S), at which XML splits a list. */
const spaceRuns = regex("[\\t\\n\\r ]+", "u")

/** Two XML whitespace characters in a row: a run of several. */
const severalSpaces = regex("[\\t\\n\\r ]{2}", "u")

/** XML whitespace before the first character or after the last. */
const outerSpace = regex("^[\\t\\n\\r ]|[\\t\\n\\r ]$", "u")

/** A tab, LF or CR in a run between two tokens. */
const innerControl = regex("[^\\t\\n\\r ][\\t\\n\\r ]*[\\t\\n\\r][\\t\\n\\r ]*[^\\t\\n\\r ]", "u")

/**
 * The tokens of a whitespace-separated list, by XML's own reading of it (XML Schema Part 2 §3.3.10, a list's lexical
 * space after whiteSpace collapse, §4.3.6): each maximal run of no XML whitespace, in order.
 */
const tokensOf = (lexical: string): ReadonlyArray<string> =>
	Arr.filter(Str.split(lexical, spaceRuns), (t) => t !== "")

/** The rules a document breaks, by the specification: its listed attributes' tokens read as XML reads a list. */
const brokenBy = (document: DrawnDocument): ReadonlySet<RuleName> => {
	const broken = new Set<RuleName>()
	const targets = new Set(document.targets)
	for (const attribute of Arr.filter(document.attributes, (a) => a.listed)) {
		const tokens = tokensOf(attribute.lexical)
		if (Arr.some(tokens, (t) => !targets.has(t))) {
			broken.add("Idref target")
		}
		if (new Set(tokens).size < tokens.length) {
			broken.add("Distinct tokens")
		}
		if (tokens.length > longest) {
			broken.add("Short list")
		}
	}
	return broken
}

/** The situations a case's documents reach, by what their lists hold. */
const listFeatures = (written: Written): ReadonlyArray<TokensFeature> => {
	const lists = Arr.flatMap(written.documents, (d) =>
		Arr.map(
			Arr.filter(d.attributes, (a) => a.listed),
			(a) => a.lexical
		)
	)
	return [
		...(Arr.some(lists, (l) => tokensOf(l).length === 0)
			? ["a list of whitespace alone" as const]
			: []),
		...(Arr.some(lists, (l) => severalSpaces.test(l))
			? ["a run of several whitespace characters" as const]
			: []),
		...(Arr.some(lists, (l) => outerSpace.test(l))
			? ["whitespace before the first token or after the last" as const]
			: []),
		...(Arr.some(lists, (l) => innerControl.test(l))
			? ["a tab, LF or CR between two tokens" as const]
			: []),
		...(Arr.some(lists, (l) => tokensOf(l).length === longest)
			? ["a list of exactly the longest length" as const]
			: []),
		...(written.documents.length > 1 ? ["two documents in one transaction" as const] : [])
	]
}

/** A disagreement between the judge and the specification, naming the case. */
class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** Every law a refusal's constraint serves, through the installation's constraint map: none for another table's. */
const refusedLaws = (
	installation: Installation,
	fields: { readonly table: Option.Option<string>; readonly constraint: string | undefined }
): ReadonlyArray<LawId> => {
	if (Option.isNone(fields.table) || fields.constraint === undefined) {
		return []
	}
	const table = fields.table.value
	const owner = Arr.findFirst(
		["Attribute", "Target"],
		(r) => installation.names.relation(r).name === table
	)
	return Option.isNone(owner)
		? []
		: (lawsOfConstraint(
				installation.constraintToLaw,
				{ kind: "table", name: installation.names.relation(owner.value).name },
				fields.constraint
			) ?? [])
}

/** The rule law `law` of the installation states, by its name: Idref target its containment, and the key and check. */
const ruleNameOf = (installation: Installation, law: LawId): RuleName => {
	const detail = defined(
		Arr.findFirst(installation.laws.theory.laws, (l) => l.id === law).pipe(Option.getOrUndefined),
		`the law ${law}`
	).detail
	assert.ok(detail.kind === "rule", `the law ${law} is a rule over a query`)
	assert.ok(detail.rule.kind === "whole", `the law ${law} is judged whole, unit-local`)
	const stated = detail.rule.law
	return stated.kind === "contained"
		? "Idref target"
		: stated.kind === "key"
			? "Distinct tokens"
			: "Short list"
}

/** A text as an SQL literal: each quote doubled. */
const literal = (text: string): string => `'${Str.replaceAll("'", "''")(text)}'`

/**
 * One case of the equivalence in its one transaction, which the case's end rolls back: the documents written whole,
 * their attributes and targets, then the judge (SET CONSTRAINTS ALL IMMEDIATE). It refuses exactly where a document
 * breaks a rule as the specification reads its lists, XML's split of each at its whitespace runs (`brokenBy`), naming
 * a rule some document breaks.
 */
export const runWritten = (
	installed: Installed,
	connection: PgConnection,
	written: Written,
	c: Case<TokensFeature>
) =>
	Effect.gen(function* () {
		const names = namesOf(installed)
		const attribute = names.table(Attribute)
		const target = names.table(Target)
		const a = (f: "package" | "path" | "start" | "lexical" | "listed") => names.column(Attribute, f)
		const t = (f: "package" | "path" | "id") => names.column(Target, f)
		yield* connection.query("SET CONSTRAINTS ALL DEFERRED", [])
		for (const document of written.documents) {
			for (const at of document.attributes) {
				yield* connection.query(
					`INSERT INTO ${attribute} (${a("package")}, ${a("path")}, ${a("start")}, ${a("lexical")}, ${a("listed")}) VALUES ('p', ${literal(document.path)}, ${at.start}, ${literal(at.lexical)}, ${at.listed})`,
					[]
				)
			}
			for (const id of Arr.dedupe(document.targets)) {
				yield* connection.query(
					`INSERT INTO ${target} (${t("package")}, ${t("path")}, ${t("id")}) VALUES ('p', ${literal(document.path)}, ${literal(id)})`,
					[]
				)
			}
		}
		const broken = new Set(Arr.flatMap(written.documents, (d) => [...brokenBy(d)]))
		const where = Formatter.format(written)
		const refused = yield* refusalOf(connection.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		for (const feature of listFeatures(written)) {
			c.note(feature)
		}
		if (Option.isNone(refused)) {
			if (broken.size > 0) {
				return yield* new Disagreed({
					message: `the judge accepted documents breaking ${Formatter.format([...broken])} as XML reads their lists: ${where}`
				})
			}
			c.note("accepted")
			return
		}
		const rule = Arr.findFirst(
			Arr.map(refusedLaws(installed.installation, refused.value), (law) =>
				ruleNameOf(installed.installation, law)
			),
			(r) => broken.has(r)
		).pipe(Option.getOrUndefined)
		if (rule === undefined) {
			return yield* new Disagreed({
				message: `the judge refused under ${refused.value.code} ${refused.value.constraint ?? "naming no constraint"} where XML's reading of the lists finds ${Formatter.format([...broken])}: ${where}`
			})
		}
		c.note(`refused by ${rule}`)
	})

/**
 * A case of the locality: the documents stored beside the written one, then as many again, the statistics, and the
 * documents a transaction then writes, and four times as many.
 */
export interface TokensLocality {
	readonly statistics: "none" | "analyzed"
	readonly written: number
}

export const tokensLocalityGen: Gen<TokensLocality> = (s) => ({
	statistics: s.draw(element(["none", "analyzed"] as const)),
	written: s.draw(int(30, 60))
})

export type TokensLocalityFeature = "measured with no statistics" | "measured analyzed"

/** The statements writing lawful documents `from` to `to` of the tables, each its two attributes and three targets. */
const documentsSql = (installed: Installed, from: number, to: number): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const attribute = names.table(Attribute)
	const target = names.table(Target)
	const a = (f: "package" | "path" | "start" | "lexical" | "listed") => names.column(Attribute, f)
	const t = (f: "package" | "path" | "id") => names.column(Target, f)
	const documents = `generate_series(${from}, ${to}) AS g(d)`
	return [
		`INSERT INTO ${attribute} (${a("package")}, ${a("path")}, ${a("start")}, ${a("lexical")}, ${a("listed")}) SELECT 'p', 'd' || d, 0, ' a  b' || chr(9) || 'ab ', true FROM ${documents}`,
		`INSERT INTO ${attribute} (${a("package")}, ${a("path")}, ${a("start")}, ${a("lexical")}, ${a("listed")}) SELECT 'p', 'd' || d, 1, 'not a list', false FROM ${documents}`,
		`INSERT INTO ${target} (${t("package")}, ${t("path")}, ${t("id")}) SELECT 'p', 'd' || d, id FROM ${documents}, unnest(ARRAY['a', 'b', 'ab']) AS i(id)`
	]
}

/**
 * The documents stored beside the written one, a template's: thousands, then twice as many, each lawful, an IDREFS of
 * three tokens and a plain attribute, documents 10 and up.
 */
const localitySizes = { stored: 2500, more: 5000 } as const

/**
 * tokensSchema installed, and `documents` lawful documents, 10 to documents + 9, committed through the captures once
 * per member, judged at their COMMIT (stored.ts storedSeed).
 */
const localityTemplate = (documents: number): SubstrateTemplate<Installed> =>
	seededTemplate({
		declaredIn: import.meta,
		name: `rule tokens locality ${documents}`,
		schema: tokensSchema,
		options: { ambient: ordinarySession, extensions: [], label: "rule_tokens" },
		seed: storedSeed((installed) => documentsSql(installed, 10, documents + 9))
	})

export const localityTemplates = {
	stored: localityTemplate(localitySizes.stored),
	more: localityTemplate(localitySizes.more)
} as const

/**
 * One locality case over two clones, each in one transaction the case's end rolls back: on `stored`'s, beside its
 * template's committed lawful documents (localityTemplates), ANALYZE where the case draws it, and one document written
 * whole through the captures; each whole rule's statement is explained over the deltas that hold its rows
 * (test/support/judge.ts judgedPlans), before the judge, which runs at the case's end; then the same on `more`'s,
 * beside twice as many documents: each reads fewer rows than the documents beside the written one, both times, the
 * written document's tokens alone, never a token of another document. Then, on `more`'s, `written` documents are
 * written whole, and four times as many: every node a statement runs more than once reads fewer rows a run than the
 * documents written, one written unit's rows a run, so the judge's work grows with the units written, never with their
 * square. That is the work a publish's judge does for these rules: the tokens of the documents it writes, once each.
 */
export const runTokensLocality = (
	stored: { readonly installed: Installed; readonly connection: PgConnection },
	more: { readonly installed: Installed; readonly connection: PgConnection },
	locality: TokensLocality,
	c: Case<TokensLocalityFeature>
) =>
	Effect.gen(function* () {
		/** The judge's reads over document 0 written whole on one clone. */
		const measured = (installed: Installed, connection: PgConnection) =>
			Effect.gen(function* () {
				const names = namesOf(installed)
				for (const sql of [
					...(locality.statistics === "analyzed"
						? [`ANALYZE ${names.table(Attribute)}`, `ANALYZE ${names.table(Target)}`]
						: []),
					"SET CONSTRAINTS ALL DEFERRED",
					...documentsSql(installed, 0, 0)
				]) {
					yield* connection.query(sql, [])
				}
				return yield* readsOf(installed, connection)
			})
		const first = yield* measured(stored.installed, stored.connection)
		assert.ok(first.length > 0, "the judge holds a whole rule's statement")
		yield* stored.connection.query("SET CONSTRAINTS ALL IMMEDIATE", [])
		const again = yield* measured(more.installed, more.connection)
		assert.ok(
			Arr.every([...first, ...again], (rows) => rows < localitySizes.stored),
			`${Formatter.format(locality)}: each whole rule's statement reads the written document's tokens alone, fewer rows than the ${localitySizes.stored} documents beside it, ${Formatter.format(first)} and then ${Formatter.format(again)} beside ${localitySizes.more}`
		)
		const { installed, connection } = more
		for (const [low, high] of [
			[-locality.written, -1],
			[-5 * locality.written, -locality.written - 1]
		] as const) {
			for (const sql of ["SET CONSTRAINTS ALL DEFERRED", ...documentsSql(installed, low, high)]) {
				yield* connection.query(sql, [])
			}
			const documents = 1 - low
			const reruns = yield* rerunsOf(installed, connection)
			assert.ok(
				Arr.every(reruns, (r) => r === undefined || r.rows < documents),
				`${Formatter.format(locality)}: each node a whole rule's statement runs more than once reads one written document a run, fewer rows than the ${documents} documents written: ${Formatter.format(reruns)}`
			)
		}
		yield* connection.query("SET CONSTRAINTS ALL IMMEDIATE", [])
		c.note(locality.statistics === "none" ? "measured with no statistics" : "measured analyzed")
	})
