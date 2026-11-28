/** What the property of literals.test.ts reads: its space, its schema, the text tool it models and its run. */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, String as Str } from "effect"
import { mismatchLine } from "#adapter/admission/drift.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { Logic, Text } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { check, contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { succeeded } from "#test/support/assert.ts"
import { joined } from "#test/support/chunked.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { atName } from "#test/support/kernel/naming.ts"
import {
	asDrafted,
	compile,
	draftedAt,
	fromEmpty,
	generate,
	noDeclarations
} from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import {
	apply,
	checkedAdmission,
	keeping,
	openMigrator,
	reviewedSource
} from "#test/support/pg/migrate/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The runs a case's texts are made of: every line boundary of Python's str.splitlines, a carriage return and line feed
 * alone and as a pair among them, which a text tool may rewrite as a line feed; a tab and other C0 and C1 controls,
 * DEL among them; the quote and backslash an escape string doubles, and a backslash before an escape's letter; a
 * dollar quote and an escape string's prefix; and characters of one, two and four UTF-8 bytes.
 */
const runs = [
	"\r",
	"\n",
	"\r\n",
	"\t",
	"\u000b",
	"\u000c",
	"\u0001",
	"\u001c",
	"\u001f",
	"\u007f",
	"\u0085",
	"\u009f",
	"\u2028",
	"\u2029",
	"'",
	"\\",
	"\\r",
	"$$",
	"E'",
	"a",
	"Z",
	" ",
	"é",
	"😀"
] as const

/**
 * How long a text is for the search to call it long: 2^17 UTF-16 code units, a third of the 394,387 characters of the
 * CHECK WINDOW2's report drifted on.
 */
const longUnits = 131_072

/** A text of one to eight drawn runs. */
const shortText: Gen<string> = (source) =>
	Arr.join(source.draw(array(element(runs), { min: 1, max: 8 })), "")

/** A short text repeated until it is long, past longUnits and short of twice it. */
const longText: Gen<string> = (source) => {
	const unit = source.draw(shortText)
	const units = source.draw(int(longUnits, 2 * longUnits))
	return Str.repeat(Math.ceil(units / unit.length))(unit)
}

const text: Gen<string> = weighted([
	[9, shortText],
	[1, longText]
])

/**
 * A case: the texts a check each forbids Doc's kind to be, and the text the derived relation D selects Doc's rows by,
 * which the rule's judges and its validation hold in their bodies.
 */
export interface LiteralCase {
	readonly forbidden: Arr.NonEmptyReadonlyArray<string>
	readonly selected: string
}

export const caseGen: Gen<LiteralCase> = (source) => ({
	forbidden: [source.draw(text), ...source.draw(array(text, { min: 0, max: 2 }))],
	selected: source.draw(text)
})

/** What a case reaches: each kind of run in a check's constant and in a function body's, a long one, and each probe. */
export type LiteralFeature =
	| "a carriage return in a check's constant"
	| "a line feed in a check's constant"
	| "a CR LF pair in a check's constant"
	| "a tab in a check's constant"
	| "another C0 control in a check's constant"
	| "a C1 control or DEL in a check's constant"
	| "a line or paragraph separator in a check's constant"
	| "a quote and a backslash in a check's constant"
	| "a long check constant"
	| "a carriage return in a function body's constant"
	| "a line or paragraph separator in a function body's constant"
	| "a long function body constant"
	| "the selected text judged in D"
	| "the selected text rewritten judged out of D"

export const literalFeatures = [
	"a carriage return in a check's constant",
	"a line feed in a check's constant",
	"a CR LF pair in a check's constant",
	"a tab in a check's constant",
	"another C0 control in a check's constant",
	"a C1 control or DEL in a check's constant",
	"a line or paragraph separator in a check's constant",
	"a quote and a backslash in a check's constant",
	"a long check constant",
	"a carriage return in a function body's constant",
	"a line or paragraph separator in a function body's constant",
	"a long function body constant",
	"the selected text judged in D",
	"the selected text rewritten judged out of D"
] as const satisfies ReadonlyArray<Reached<LiteralFeature>>

const isOtherC0 = (ch: string): boolean =>
	Arr.contains(["\u0001", "\u000b", "\u000c", "\u001c", "\u001f"], ch)
const isC1OrDel = (ch: string): boolean => ch >= "\u007f" && ch <= "\u009f"
const isSeparator = (ch: string): boolean => ch === "\u2028" || ch === "\u2029"

/** Whether `t` holds a character `is` holds of. */
const holdsOf = (t: string, is: (ch: string) => boolean): boolean => Arr.some(Array.from(t), is)

/** What a case's texts reach, before it runs. */
const textFeaturesOf = (c: LiteralCase): ReadonlyArray<LiteralFeature> => {
	const any = (holds: (t: string) => boolean) => Arr.some(c.forbidden, holds)
	return [
		...(any(Str.includes("\r")) ? ["a carriage return in a check's constant" as const] : []),
		...(any(Str.includes("\n")) ? ["a line feed in a check's constant" as const] : []),
		...(any(Str.includes("\r\n")) ? ["a CR LF pair in a check's constant" as const] : []),
		...(any(Str.includes("\t")) ? ["a tab in a check's constant" as const] : []),
		...(any((t) => holdsOf(t, isOtherC0))
			? ["another C0 control in a check's constant" as const]
			: []),
		...(any((t) => holdsOf(t, isC1OrDel))
			? ["a C1 control or DEL in a check's constant" as const]
			: []),
		...(any((t) => holdsOf(t, isSeparator))
			? ["a line or paragraph separator in a check's constant" as const]
			: []),
		...(any(Str.includes("'")) && any(Str.includes("\\"))
			? ["a quote and a backslash in a check's constant" as const]
			: []),
		...(Arr.some(c.forbidden, (t) => t.length >= longUnits)
			? ["a long check constant" as const]
			: []),
		...(Str.includes("\r")(c.selected)
			? ["a carriage return in a function body's constant" as const]
			: []),
		...(holdsOf(c.selected, isSeparator)
			? ["a line or paragraph separator in a function body's constant" as const]
			: []),
		...(c.selected.length >= longUnits ? ["a long function body constant" as const] : [])
	]
}

/** A case aimed at `feature`: the drawn case with the run that reaches it placed in the text it concerns. */
const withRun =
	(run: string, where: "forbidden" | "selected"): Gen<LiteralCase> =>
	(source) => {
		const c = source.draw(caseGen)
		const [first, ...rest] = c.forbidden
		const placed = (t: string) => `${t}${run}${source.draw(shortText)}`
		return where === "forbidden"
			? { ...c, forbidden: [placed(first), ...rest] }
			: { ...c, selected: placed(c.selected) }
	}

/** A case whose first forbidden text, or selected text, is long. */
const withLong =
	(where: "forbidden" | "selected"): Gen<LiteralCase> =>
	(source) => {
		const c = source.draw(caseGen)
		const [, ...rest] = c.forbidden
		const long = source.draw(longText)
		return where === "forbidden" ? { ...c, forbidden: [long, ...rest] } : { ...c, selected: long }
	}

/** A case whose selected text a rewrite changes and whose texts the checks admit, rewritten or not. */
const judged: Gen<LiteralCase> = (source) => {
	const c = source.draw(caseGen)
	return { ...c, selected: `${source.draw(shortText)}\r${source.draw(shortText)}\u2028` }
}

export const aims: ReadonlyArray<readonly [Reached<LiteralFeature>, Gen<LiteralCase>]> = [
	["a carriage return in a check's constant", withRun("\r", "forbidden")],
	["a line feed in a check's constant", withRun("\n", "forbidden")],
	["a CR LF pair in a check's constant", withRun("\r\n", "forbidden")],
	["a tab in a check's constant", withRun("\t", "forbidden")],
	["another C0 control in a check's constant", withRun("\u000b", "forbidden")],
	["a C1 control or DEL in a check's constant", withRun("\u0085", "forbidden")],
	["a line or paragraph separator in a check's constant", withRun("\u2028", "forbidden")],
	["a quote and a backslash in a check's constant", withRun("'\\", "forbidden")],
	["a long check constant", withLong("forbidden")],
	["a carriage return in a function body's constant", withRun("\r", "selected")],
	["a line or paragraph separator in a function body's constant", withRun("\u2029", "selected")],
	["a long function body constant", withLong("selected")],
	["the selected text judged in D", judged],
	["the selected text rewritten judged out of D", judged]
]

/** Whether a character is a line boundary of Python's str.splitlines other than the line feed and the CR LF pair. */
const isBoundary = (ch: string): boolean =>
	Arr.contains(
		["\r", "\u000b", "\u000c", "\u001c", "\u001d", "\u001e", "\u0085", "\u2028", "\u2029"],
		ch
	)

/**
 * A text read and written back by a tool that reads it as lines, as Python's text mode and str.splitlines do and an
 * editor that normalizes line endings: every line boundary str.splitlines recognizes, a CR LF pair as one, written as a
 * line feed.
 */
const rewritten = (t: string): string =>
	Arr.join(
		Arr.map(Str.split("\r\n")(t), (piece) =>
			Arr.join(
				Arr.map(Array.from(piece), (ch) => (isBoundary(ch) ? "\n" : ch)),
				""
			)
		),
		"\n"
	)

/** XML Schema's whiteSpace collapse, the host's: tab, LF and CR a space, each run of spaces one, none at either end. */
const collapsedOf = (t: string): string =>
	Arr.join(
		Arr.filter(
			Str.split(" ")(
				Arr.join(
					Arr.map(Array.from(t), (ch) => (Arr.contains(["\t", "\n", "\r"], ch) ? " " : ch)),
					""
				)
			),
			(w) => w !== ""
		),
		" "
	)

/** Any text, as a field holds it. */
const Prose = str.regex("^.*$", "su")

const Doc = relation("Doc", { node: pg.integer, kind: Prose }, ["node"])

const Extra = relation("Extra", { node: pg.integer }, ["node"])

const Use = relation("Use", { id: pg.integer, doc: pg.integer }, ["id"])

/**
 * The case's schema under `name`: a check per forbidden text that Doc's kind is not it, a check that its collapse is
 * not the first forbidden text's (the replace chain of WINDOW2's CHECKs, its tab, LF and CR constants beside the drawn
 * one); and in a level above, D, Doc's rows of the selected kind outside Extra, which no foreign key holds, so the rule
 * holding each Use's doc in D is kept by triggers whose bodies hold the selected text, as its validation's does.
 */
const schemaOf = (name: string, c: LiteralCase) => {
	const Base = schema(
		name,
		[Doc, Extra, Use],
		[
			...Arr.map(c.forbidden, (t, i) => check(`NotForbidden${i}`, Doc, (d) => d.ne(d.kind, t))),
			check("NotCollapsed", Doc, (d) =>
				Logic.ne(Text.collapse(d.kind), collapsedOf(c.forbidden[0]))
			)
		]
	)
	const D = derived(
		"D",
		query(Base).rule((r) => {
			const { node } = v(Doc, "d")
			return r.match(Doc, { node, kind: c.selected }).where(r.not(Extra, { node })).find({ node })
		})
	)
	return schema.extend([Base], `${name}_1`, [D], [contained(on(Use, "doc"), on(D, "node"))])
}

/** A write's outcome: committed, or refused with the SQLSTATE PostgreSQL refused it with. */
type Outcome = { readonly kind: "committed" } | { readonly kind: "refused"; readonly code: string }

/** `statements` as the cluster's superuser, at SERIALIZABLE, committed: a grizzle table takes no other write. */
const written = (
	admin: PgConnection,
	statements: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]>
): Effect.Effect<Outcome> =>
	Effect.scoped(
		Effect.gen(function* () {
			const pinned = yield* admin.pin
			yield* Effect.orDie(pinned.query("BEGIN ISOLATION LEVEL SERIALIZABLE", []))
			const ran = yield* Effect.result(
				Effect.gen(function* () {
					for (const [sql, params] of statements) {
						yield* pinned.query(sql, params)
					}
					yield* pinned.query("COMMIT", [])
				})
			)
			if (ran._tag === "Success") {
				return { kind: "committed" }
			}
			yield* Effect.orDie(pinned.query("ROLLBACK", []))
			const reason = ran.failure.reason
			assert.ok(
				reason._tag === "ServerError",
				`the write reached the server: ${ran.failure.message}`
			)
			return { kind: "refused", code: reason.fields.code }
		})
	)

/**
 * The case, drafted as `grizzle generate` drafts a first installation, each file read and written back by the text tool
 * (rewritten), which must leave it byte for byte, and applied by the real runner as the owner, whose drift check, and
 * the installed-catalog checker after it, must admit the catalog it reaches; then the constants are the drawn texts:
 * each forbidden text is refused (23514), and where the checks admit the selected text, a Use of a Doc of it commits,
 * and one of a Doc of its rewrite, where that differs and the checks admit it, is refused by the rule (23503).
 */
export const runCase = (c: LiteralCase, note: (feature: LiteralFeature) => void) =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const name = yield* substrate.schema({ create: false, label: "literals" })
		yield* Effect.addFinalizer(() =>
			Effect.orDie(
				substrate.admin.query(`DROP SCHEMA IF EXISTS ${quoteIdent(`${name}_1`)} CASCADE`, [])
			)
		)
		for (const feature of textFeaturesOf(c)) {
			note(feature)
		}
		const installation = compile(schemaOf(name, c), { ...asDrafted, schema: atName(name) })
		const g = succeeded(
			generate({
				previous: fromEmpty,
				installation,
				name: "literals",
				timestamp: draftedAt(1),
				workload: noWorkload,
				declared: noDeclarations
			}),
			"the case's schema drafts"
		)
		const folder = reviewedSource(g, {
			decisions: () => keeping("'0'"),
			edit: (file) => rewritten(file.text)
		})
		const migrator = yield* openMigrator(substrate, substrate.owner)
		yield* Effect.catch(
			apply(
				migrator,
				{ snapshot: g.snapshot, folders: [folder] },
				checkedAdmission(installation, substrate.admin)
			),
			(e) =>
				Effect.sync(() =>
					assert.fail(
						`the rewritten folder applies and drift admits it: ${e.message}${
							e.reason._tag === "Drifted"
								? Arr.join(
										Arr.map(e.reason.mismatches, (m) => `\n  ${mismatchLine(m)}`),
										""
									)
								: ""
						}`
					)
				)
		)
		for (const file of g.folder.files) {
			assert.ok(
				rewritten(joined(file.text)) === joined(file.text),

				`${file.name} holds no line boundary a text tool rewrites, so read and written back it is itself`
			)
		}
		yield* standUpJudge(substrate.admin, installation)
		const doc = `${quoteIdent(name)}.${quoteIdent("doc")}`
		const use = `${quoteIdent(name)}.${quoteIdent("use")}`
		const putDoc = (node: number, kind: string) =>
			[`INSERT INTO ${doc} ("node", "kind") VALUES ($1::int4, $2::text)`, [node, kind]] as const
		const putUse = (id: number, node: number) =>
			[`INSERT INTO ${use} ("id", "doc") VALUES ($1::int4, $2::int4)`, [id, node]] as const
		for (const [i, t] of c.forbidden.entries()) {
			const outcome = yield* written(substrate.admin, [putDoc(i + 1, t)])
			assert.deepEqual(
				outcome,
				{ kind: "refused", code: "23514" },
				`a Doc of forbidden text ${i} is refused by its check`
			)
		}
		const admitted = (t: string) =>
			!Arr.contains(c.forbidden, t) && collapsedOf(t) !== collapsedOf(c.forbidden[0])
		if (admitted(c.selected)) {
			const outcome = yield* written(substrate.admin, [putDoc(100, c.selected), putUse(100, 100)])
			assert.deepEqual(
				outcome,
				{ kind: "committed" },
				"a Use of a Doc of the selected text, which D holds, commits"
			)
			note("the selected text judged in D")
		}
		const other = rewritten(c.selected)
		if (other !== c.selected && admitted(other)) {
			const outcome = yield* written(substrate.admin, [putDoc(200, other), putUse(200, 200)])
			assert.deepEqual(
				outcome,
				{ kind: "refused", code: "23503" },
				"a Use of a Doc of the selected text rewritten, which D does not hold, is refused by the rule"
			)
			note("the selected text rewritten judged out of D")
		}
	}).pipe(Effect.scoped)
