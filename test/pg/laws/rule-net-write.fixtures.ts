/** What the properties of rule-net-write.test.ts read: the schema and its template, the spaces, and each case's run. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { aimed, array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option, String as Str } from "effect"
import { rowsRead } from "#bench/harness/explain.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import {
	baselineRuleChecks,
	definedRuleChecks,
	lawChecks
} from "#compiler/deploy/snapshot/violation.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import { countColumn } from "#compiler/physical/ddl/deltas.ts"
import { compileInstallation } from "#compiler/physical/install/compile.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, mutable, on, relation, schema, unit } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { PlStatement } from "#compiler/sql/ast.ts"
import { printStatement } from "#compiler/sql/print.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import {
	capturedDeltasOf,
	foundQueryOf,
	judgeBodiesOf,
	judgeRun,
	judgeStatementsOf,
	standUpJudge
} from "#test/support/judge.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { PgConnection } from "#test/support/pg.ts"
import { refusalOf } from "#test/support/substrate.ts"
import type { CaseSession, RawSession } from "#test/support/substrate/session.ts"

/** A package's name, and a document's path within it: text a qti path's characters spell. */
const Path = str.regex("^[a-z0-9/._-]{1,250}$")

/** A package: a direct writer's foreign key from A cascades its deletes into A's rows (netWrite's cases add it). */
const P = relation("P", { package: Path }, ["package"])
/**
 * An attribute of a document, keyed as a qti attribute is, by its package, path, start and name: the rules read its
 * governor, and no rule reads its note.
 */
const A = relation(
	"A",
	{
		package: Path,
		path: Path,
		start: pg.bigint,
		name: pg.smallint,
		governor: pg.smallint,
		note: pg.integer
	},
	["package", "path", "start", "name"]
)
/** A reference to an attribute, at the attribute's key, its package in a pack. */
const R = relation("R", { pack: Path, path: Path, start: pg.bigint, name: pg.smallint }, [
	"pack",
	"path",
	"start",
	"name"
])
/** A name a package declares, in a pack. */
const Q = relation("Q", { pack: Path, name: pg.smallint }, ["pack", "name"])

/**
 * Mutable: P and A in the unit of their package, R and Q in the unit of their pack, so every rule over them reads the
 * rows of two units, two borrows: each is judged by its probes, whose net write the properties read, never whole over
 * its units (analysis/theory/unit.ts wholeRule).
 */
const Base = schema(
	"NetWrite",
	[P, A, R, Q],
	[
		mutable(P),
		mutable(A),
		mutable(R),
		mutable(Q),
		unit("Package", { package: Path }),
		unit("Pack", { pack: Path })
	]
)

/** The attributes of governor 1, each at its key. */
const Media = derived(
	"Media",
	query(Base).rule((r) => {
		const { package: p, path, start, name } = v(A, "a")
		return r
			.match(A, { package: p, path, start, name, governor: 1 })
			.find({ package: p, path, start, name })
	})
)

/** The names attributes of governor 2 bear, each in its package. */
const Named = derived(
	"Named",
	query(Base).rule((r) => {
		const { package: p, name } = v(A, "a")
		return r.match(A, { package: p, name, governor: 2 }).find({ package: p, name })
	})
)

/**
 * Two rules over A's facts, each a rule over a query its set judge holds: every attribute of governor 1 is referenced
 * at its key, and every name an attribute of governor 2 bears is declared in its package. The second's delete probes
 * of Q read A by (package, name) and governor 2, so its index on (governor, name, package) is an index of a strict
 * subset of A's key's columns beside it, which ties with the key's own without statistics, as a qti attribute's
 * (name, package, ...) does.
 */
const NetWrite = schema.extend(
	[Base],
	"NetWrite_1",
	[Media, Named],
	[
		contained(
			on(Media, "package", "path", "start", "name"),
			on(R, "pack", "path", "start", "name")
		),
		contained(on(Named, "package", "name"), on(Q, "pack", "name"))
	]
)

/** NetWrite installed through its first migration, with no login: the template both properties clone. */
export const netWriteTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "net write",
	content: { schema: "NetWrite", logins: [] },
	versions: [{ schema: NetWrite, logins: [], declarations: noDeclarations }],
	options: {
		label: "net_write",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/**
 * A's side of news as the judge's statements read it: the delta A's capture creates with a count of each image, its
 * images' columns, the heading's, and the part's netting of it, the DELETE whose WHERE reads the counts' sums
 * (physical/ddl/deltas.ts netted).
 */
const newsOfA = (installation: Installation) => {
	const news = defined(
		Arr.findFirst(capturedDeltasOf(installation, "A"), (d) =>
			Arr.contains(d.columns, countColumn)
		).pipe(Option.getOrUndefined),
		"A's side of news"
	)
	const nettings = (body: ReadonlyArray<PlStatement>): ReadonlyArray<string> =>
		Arr.flatMap(body, (s) =>
			s.kind === "modify" &&
			s.statement.kind === "delete" &&
			typeof s.statement.table !== "string" &&
			s.statement.table.name === news.name &&
			s.statement.where !== undefined
				? [printStatement(s.statement)]
				: s.kind === "if"
					? [...Arr.flatMap(s.branches, (b) => nettings(b.body)), ...nettings(s.else)]
					: []
		)
	/** Each part that reads A's side of news nets it first, by the one statement: Named's rules' part and Media's
	 * upkeep's, phase A's, which reads it beside A's side of olds. */
	const [netting, ...others] = Arr.dedupe(nettings(judgeBodiesOf(installation)))
	assert.ok(
		netting !== undefined && others.length === 0,
		"the judge nets A's side of news by one statement"
	)
	return {
		delta: news.name,
		images: Arr.filter(news.columns, (c) => c !== countColumn),
		netting: defined(netting, "A's netting")
	}
}

/**
 * That the side of news the judge reads holds each image once (`newsOfA`): its rows netted, as a part nets them before
 * any statement reads them, hold no image twice, since every reader of the delta deduplicates nothing
 * (physical/ddl/deltas.ts addReaders). A delta the session has not stood up holds none.
 */
const newsOnce = (installed: Installed, session: RawSession, where: string) =>
	Effect.gen(function* () {
		const news = newsOfA(installed.installation)
		const stands = yield* session.values(
			`SELECT pg_catalog.to_regclass(${quoteString(`pg_temp.${quoteIdent(news.delta)}`)}) IS NOT NULL`,
			[]
		)
		if (stands[0]?.[0] !== true) {
			return
		}
		yield* session.query(news.netting, [])
		const read = yield* session.values(
			`SELECT count(*)::int, count(DISTINCT r.*)::int FROM (SELECT ${Arr.join(Arr.map(news.images, quoteIdent), ", ")} FROM pg_temp.${quoteIdent(news.delta)}) AS r`,
			[]
		)
		if (read[0]?.[0] !== read[0]?.[1]) {
			return yield* new Disagreed({
				message: `A's side of news read ${String(read[0]?.[0])} rows after its netting, ${String(read[0]?.[1])} of them distinct, ${where}`
			})
		}
	})

/** One write of a transaction, as drawn, over two packages of one document, at two starts and two names. */
export type Op =
	| {
			readonly kind: "put"
			readonly pkg: Pkg
			readonly start: Coordinate
			readonly name: Coordinate
			readonly governor: Governor
			readonly note: Coordinate
	  }
	| {
			readonly kind: "remove"
			readonly pkg: Pkg
			readonly start: Coordinate
			readonly name: Coordinate
	  }
	| {
			readonly kind: "govern"
			readonly pkg: Pkg
			readonly start: Coordinate
			readonly name: Coordinate
			readonly governor: Governor
	  }
	| {
			readonly kind: "annotate"
			readonly pkg: Pkg
			readonly start: Coordinate
			readonly name: Coordinate
			readonly note: Coordinate
	  }
	| {
			readonly kind: "move"
			readonly pkg: Pkg
			readonly start: Coordinate
			readonly name: Coordinate
			readonly to: Coordinate
	  }
	| {
			readonly kind: "refer" | "unrefer"
			readonly pkg: Pkg
			readonly start: Coordinate
			readonly name: Coordinate
	  }
	| { readonly kind: "declare" | "undeclare"; readonly pkg: Pkg; readonly name: Coordinate }
	| { readonly kind: "drop" | "restore"; readonly pkg: Pkg }
	| { readonly kind: "judge" }

const pkgs = ["p1", "p2"] as const
type Pkg = (typeof pkgs)[number]
const coordinates = [1, 2] as const
type Coordinate = (typeof coordinates)[number]
const governors = [0, 1, 2] as const
type Governor = (typeof governors)[number]

/** A case of netWrite: its transactions, each its writes in order, every one judged as its whole check judges it. */
export interface Schedule {
	readonly transactions: ReadonlyArray<ReadonlyArray<Op>>
}

const pkgGen = element(pkgs)
const coordinateGen = element(coordinates)
const governorGen = element(governors)

const opGen: Gen<Op> = weighted<Op>([
	[
		5,
		(s) => ({
			kind: "put",
			pkg: s.draw(pkgGen),
			start: s.draw(coordinateGen),
			name: s.draw(coordinateGen),
			governor: s.draw(governorGen),
			note: s.draw(coordinateGen)
		})
	],
	[
		3,
		(s) => ({
			kind: "remove",
			pkg: s.draw(pkgGen),
			start: s.draw(coordinateGen),
			name: s.draw(coordinateGen)
		})
	],
	[
		2,
		(s) => ({
			kind: "govern",
			pkg: s.draw(pkgGen),
			start: s.draw(coordinateGen),
			name: s.draw(coordinateGen),
			governor: s.draw(governorGen)
		})
	],
	[
		2,
		(s) => ({
			kind: "annotate",
			pkg: s.draw(pkgGen),
			start: s.draw(coordinateGen),
			name: s.draw(coordinateGen),
			note: s.draw(coordinateGen)
		})
	],
	[
		2,
		(s) => ({
			kind: "move",
			pkg: s.draw(pkgGen),
			start: s.draw(coordinateGen),
			name: s.draw(coordinateGen),
			to: s.draw(coordinateGen)
		})
	],
	[
		3,
		(s) => ({
			kind: s.draw(element(["refer", "unrefer"] as const)),
			pkg: s.draw(pkgGen),
			start: s.draw(coordinateGen),
			name: s.draw(coordinateGen)
		})
	],
	[
		2,
		(s) => ({
			kind: s.draw(element(["declare", "undeclare"] as const)),
			pkg: s.draw(pkgGen),
			name: s.draw(coordinateGen)
		})
	],
	[1, (s) => ({ kind: s.draw(element(["drop", "restore"] as const)), pkg: s.draw(pkgGen) })],
	[1, () => ({ kind: "judge" })]
])

const scheduleGen: Gen<Schedule> = (s) => ({
	transactions: s.draw(array(array(opGen, { min: 1, max: 6 }), { min: 1, max: 5 }))
})

/** The situations a netWrite search must reach, each a case of the net write a removal or an update makes. */
export type NetFeature =
	| "committed"
	| "refused by a rule"
	| "an image put, removed and put again in one transaction"
	| "an image of governor 2 put and removed before its judge"
	| "an image the transaction found removed and put back as it was"
	| "a read column of a row the transaction put updated"
	| "a column no rule reads updated"
	| "a key of a row the transaction put updated"
	| "a row the transaction put removed by a cascade"
	| "the judge run inside a transaction that writes on"

export const netFeatures: Arr.NonEmptyReadonlyArray<NetFeature> = [
	"committed",
	"refused by a rule",
	"an image put, removed and put again in one transaction",
	"an image of governor 2 put and removed before its judge",
	"an image the transaction found removed and put back as it was",
	"a read column of a row the transaction put updated",
	"a column no rule reads updated",
	"a key of a row the transaction put updated",
	"a row the transaction put removed by a cascade",
	"the judge run inside a transaction that writes on"
]

/** An attribute at a drawn key, its package, start and name, with its governor and note drawn. */
const keyed = (s: Parameters<Gen<Op>>[0]) => ({
	pkg: s.draw(pkgGen),
	start: s.draw(coordinateGen),
	name: s.draw(coordinateGen)
})

/**
 * The aims of netWrite: for each situation of the net write, a case constructed to reach it, its key and whether the
 * rule it reads holds drawn, so the case commits or is refused as the draw makes it.
 */
const netAims: ReadonlyArray<readonly [NetFeature, Gen<Schedule>]> = [
	[
		"an image put, removed and put again in one transaction",
		(s) => {
			const k = keyed(s)
			return {
				transactions: [
					[
						...(s.draw(boolean) ? [{ kind: "refer" as const, ...k }] : []),
						{ kind: "put", ...k, governor: 1, note: s.draw(coordinateGen) },
						{ kind: "remove", ...k },
						{ kind: "put", ...k, governor: 1, note: s.draw(coordinateGen) }
					]
				]
			}
		}
	],
	[
		"an image of governor 2 put and removed before its judge",
		(s) => {
			const k = keyed(s)
			return {
				transactions: [
					[
						{ kind: "put", ...k, governor: 2, note: s.draw(coordinateGen) },
						{ kind: "remove", ...k },
						...(s.draw(boolean) ? [{ kind: "judge" as const }] : [])
					]
				]
			}
		}
	],
	[
		"an image the transaction found removed and put back as it was",
		(s) => {
			const k = keyed(s)
			const note = s.draw(coordinateGen)
			return {
				transactions: [
					[
						{ kind: "refer", ...k },
						{ kind: "put", ...k, governor: 1, note }
					],
					[
						...(s.draw(boolean) ? [{ kind: "unrefer" as const, ...k }] : []),
						{ kind: "remove", ...k },
						{ kind: "put", ...k, governor: 1, note: s.draw(coordinateGen) }
					]
				]
			}
		}
	],
	[
		"a read column of a row the transaction put updated",
		(s) => {
			const k = keyed(s)
			return {
				transactions: [
					[
						{ kind: "put", ...k, governor: s.draw(governorGen), note: s.draw(coordinateGen) },
						{ kind: "govern", ...k, governor: s.draw(governorGen) }
					]
				]
			}
		}
	],
	[
		"a column no rule reads updated",
		(s) => {
			const k = keyed(s)
			return {
				transactions: [
					[
						{ kind: "put", ...k, governor: 1, note: 1 },
						{ kind: "annotate", ...k, note: 2 },
						...(s.draw(boolean) ? [{ kind: "remove" as const, ...k }] : [])
					]
				]
			}
		}
	],
	[
		"a key of a row the transaction put updated",
		(s) => {
			const k = keyed(s)
			const to = s.draw(coordinateGen) === 1 ? (k.start === 1 ? 2 : 1) : k.start
			return {
				transactions: [
					[
						{ kind: "refer", ...k, start: s.draw(coordinateGen) },
						{ kind: "put", ...k, governor: 1, note: s.draw(coordinateGen) },
						{ kind: "move", ...k, to }
					]
				]
			}
		}
	],
	[
		"a row the transaction put removed by a cascade",
		(s) => {
			const k = keyed(s)
			const back: ReadonlyArray<Op> = s.draw(boolean)
				? [
						{ kind: "restore", pkg: k.pkg },
						{ kind: "put", ...k, governor: 1, note: s.draw(coordinateGen) }
					]
				: []
			return {
				transactions: [
					[
						{ kind: "put", ...k, governor: 1, note: s.draw(coordinateGen) },
						{ kind: "drop", pkg: k.pkg },
						...back
					]
				]
			}
		}
	],
	[
		"the judge run inside a transaction that writes on",
		(s) => {
			const k = keyed(s)
			const after: ReadonlyArray<Op> = s.draw(boolean)
				? [{ kind: "unrefer", ...k }]
				: [
						{ kind: "remove", ...k },
						{ kind: "put", ...k, governor: 1, note: s.draw(coordinateGen) }
					]
			return {
				transactions: [
					[
						{ kind: "refer", ...k },
						{ kind: "put", ...k, governor: 1, note: s.draw(coordinateGen) },
						{ kind: "judge" },
						...after
					]
				]
			}
		}
	]
]

export const netSpace = aimed(scheduleGen, netAims)

/** The statement of one write, on the installation's names, the document's path "d". */
const statementOf = (installed: Installed, op: Exclude<Op, { readonly kind: "judge" }>): string => {
	const names = namesOf(installed)
	const a = names.table(A)
	const text = (x: string) => `'${x}'`
	const at = (
		o: { readonly pkg: Pkg; readonly start: Coordinate; readonly name: Coordinate },
		key: "package" | "pack"
	) => `${key} = ${text(o.pkg)} AND path = 'd' AND start = ${o.start} AND name = ${o.name}`
	switch (op.kind) {
		case "put":
			return `INSERT INTO ${a} (package, path, start, name, governor, note) SELECT ${text(op.pkg)}, 'd', ${op.start}, ${op.name}, ${op.governor}, ${op.note} WHERE EXISTS (SELECT FROM ${names.table(P)} WHERE package = ${text(op.pkg)}) ON CONFLICT DO NOTHING`
		case "remove":
			return `DELETE FROM ${a} WHERE ${at(op, "package")}`
		case "govern":
			return `UPDATE ${a} SET governor = ${op.governor} WHERE ${at(op, "package")}`
		case "annotate":
			return `UPDATE ${a} SET note = ${op.note} WHERE ${at(op, "package")}`
		case "move":
			return `UPDATE ${a} SET start = ${op.to} WHERE ${at(op, "package")} AND NOT EXISTS (SELECT FROM ${a} AS b WHERE b.package = ${text(op.pkg)} AND b.path = 'd' AND b.start = ${op.to} AND b.name = ${op.name})`
		case "refer":
			return `INSERT INTO ${names.table(R)} (pack, path, start, name) VALUES (${text(op.pkg)}, 'd', ${op.start}, ${op.name}) ON CONFLICT DO NOTHING`
		case "unrefer":
			return `DELETE FROM ${names.table(R)} WHERE ${at(op, "pack")}`
		case "declare":
			return `INSERT INTO ${names.table(Q)} (pack, name) VALUES (${text(op.pkg)}, ${op.name}) ON CONFLICT DO NOTHING`
		case "undeclare":
			return `DELETE FROM ${names.table(Q)} WHERE pack = ${text(op.pkg)} AND name = ${op.name}`
		case "drop":
			return `DELETE FROM ${names.table(P)} WHERE package = ${text(op.pkg)}`
		case "restore":
			return `INSERT INTO ${names.table(P)} (package) VALUES (${text(op.pkg)}) ON CONFLICT DO NOTHING`
	}
}

/** An attribute row as a snapshot reads it: its key, its image (the key and governor) and its note. */
interface Stood {
	readonly key: string
	readonly image: string
	readonly note: number
}

/** A's rows as they stand on `session`. */
const standingOf = (installed: Installed, session: CaseSession) =>
	Effect.map(
		session.values(
			`SELECT package::text, start::int, name::int, governor::int, note FROM ${namesOf(installed).table(A)}`,
			[]
		),
		(rows) =>
			Arr.map(rows, (row): Stood => {
				const key = `${String(row[0])}/${String(row[1])}/${String(row[2])}`
				return { key, image: `${key}:${String(row[3])}`, note: Number(row[4]) }
			})
	)

/** How one transaction's images moved, statement by statement: each image's puts and removals in order. */
type Moves = Map<string, Array<"put" | "removed">>

/**
 * The situation a judge reaches over how its transaction's images moved: an image of governor 2, which Named's rule
 * reads from A's side of news, put by the transaction and removed since, so its puts and removals cancel there: read as
 * standing where its package declares no name, as in the situation's aim, it would break the rule, so a netting that
 * kept it refuses a transaction the rule's whole check finds kept.
 */
const reachedAtJudge = (moves: Moves): ReadonlyArray<NetFeature> =>
	Arr.some(
		[...moves.entries()],
		([image, m]) => Str.endsWith(":2")(image) && m[0] === "put" && m[m.length - 1] === "removed"
	)
		? ["an image of governor 2 put and removed before its judge"]
		: []

/**
 * The situations one statement of a transaction reaches, from A's rows before and after it, the images the transaction
 * found when it began (`found`) and how its images moved before it (`moves`), which it extends.
 */
const reachedBy = (
	op: Exclude<Op, { readonly kind: "judge" }>,
	before: ReadonlyArray<Stood>,
	after: ReadonlyArray<Stood>,
	found: ReadonlySet<string>,
	moves: Moves
): ReadonlyArray<NetFeature> => {
	const was = new Set(Arr.map(before, (r) => r.image))
	const is = new Set(Arr.map(after, (r) => r.image))
	const putBefore = (key: string) =>
		Arr.some(
			[...moves.entries()],
			([image, m]) => Str.startsWith(`${key}:`)(image) && Arr.contains(m, "put")
		)
	const reached: Array<NetFeature> = []
	for (const r of before) {
		if (is.has(r.image)) {
			continue
		}
		moves.set(r.image, [...(moves.get(r.image) ?? []), "removed"])
		if (op.kind === "drop" && putBefore(r.key)) {
			reached.push("a row the transaction put removed by a cascade")
		}
		if (op.kind === "govern" && putBefore(r.key)) {
			reached.push("a read column of a row the transaction put updated")
		}
		if (op.kind === "move" && putBefore(r.key)) {
			reached.push("a key of a row the transaction put updated")
		}
	}
	for (const r of after) {
		if (was.has(r.image)) {
			continue
		}
		const m = [...(moves.get(r.image) ?? []), "put" as const]
		moves.set(r.image, m)
		if (Str.includes("put removed put")(Arr.join(m, " "))) {
			reached.push("an image put, removed and put again in one transaction")
		}
		if (found.has(r.image) && Str.startsWith("removed put")(Arr.join(m, " "))) {
			reached.push("an image the transaction found removed and put back as it was")
		}
	}
	if (
		op.kind === "annotate" &&
		Arr.some(after, (r) => Arr.some(before, (b) => b.image === r.image && b.note !== r.note))
	) {
		reached.push("a column no rule reads updated")
	}
	return reached
}

/**
 * Every law a refusal's constraint serves, through the installation's constraint map: none for another table's. A
 * rule's raise names the table of the relation its trigger stands on: a stored relation's own, Media's, whose rule
 * reads its table and its deltas.
 */
const refusedLaws = (
	installation: Installation,
	fields: { readonly table: Option.Option<string>; readonly constraint: string | undefined }
): ReadonlyArray<LawId> => {
	if (Option.isNone(fields.table) || fields.constraint === undefined) {
		return []
	}
	const table = fields.table.value
	const owner = Arr.findFirst(
		["P", "A", "R", "Q", "Media"],
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

/**
 * Judges the state `session`'s transaction leaves against every rule's whole check, then runs the judge (SET
 * CONSTRAINTS ALL IMMEDIATE): it must refuse exactly when a whole check finds the state broken, under 23503 naming a
 * rule it finds broken. Answers whether it refused. The whole check the judge is held to reads every derived relation
 * through its definition (deploy/snapshot/violation.ts definedRuleChecks), the state the judge judges once its upkeep
 * made Media's table its definition's rows (Media is stored, its unit A's whole key, wider than its package); each
 * rule's check over every row reads Media's table as the last COMMIT left it, as the migration that adds the rule runs
 * it over tables its fill made current, so it is held to its violation query read as installed (baselineRuleChecks),
 * which reads the same tables.
 */
const judged = (installed: Installed, session: RawSession, where: string) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const foundBy = (query: Parameters<typeof printStatement>[0]) =>
			Effect.map(
				session.values(`SELECT EXISTS (${printStatement(query)})`, []),
				(found) => found[0]?.[0] === true
			)
		const broken = new Set<LawId>()
		for (const check of definedRuleChecks(installation)) {
			if (yield* foundBy(check.query)) {
				broken.add(check.law)
			}
		}
		const installedBroken = new Set<LawId>()
		for (const check of baselineRuleChecks(installation)) {
			if (yield* foundBy(check.query)) {
				installedBroken.add(check.law)
			}
		}
		for (const check of lawChecks(installation).rules) {
			const found = yield* session.values(foundQueryOf(check.query), [])
			if ((found[0]?.[0] === true) !== installedBroken.has(check.law)) {
				return yield* new Disagreed({
					message: `the check over every row of ${check.law} finds ${found[0]?.[0] === true ? "a row" : "none"} where its whole check as installed finds ${installedBroken.has(check.law) ? "the rule broken" : "nothing"}, ${where}`
				})
			}
		}
		const refused = yield* refusalOf(session.query("SET CONSTRAINTS ALL IMMEDIATE", []))
		if (Option.isNone(refused)) {
			if (broken.size > 0) {
				return yield* new Disagreed({
					message: `the judge accepted a state its whole checks find breaking ${Formatter.format([...broken])}, ${where}`
				})
			}
			return false
		}
		const laws = refusedLaws(installation, refused.value)
		if (refused.value.code !== "23503" || !Arr.some(laws, (law) => broken.has(law))) {
			return yield* new Disagreed({
				message: `the judge refused under ${refused.value.code} ${refused.value.constraint ?? "naming no constraint"} where the whole checks find ${Formatter.format([...broken])}, ${where}`
			})
		}
		return true
	})

/**
 * One netWrite case on its own clone: a direct writer's foreign key from A to P that cascades its deletes, both
 * packages present, then each transaction's writes in order on an owner session at SERIALIZABLE. Each judge op and the
 * transaction's end judge the state as `judged` does; a refusal rolls the transaction back, and a judge op that
 * accepts puts the constraints back to deferred, so the transaction writes on under the judge's netting.
 */
export const runSchedule = (
	installed: Installed,
	admin: PgConnection,
	session: RawSession,
	schedule: Schedule,
	c: Case<NetFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(admin, installed.installation)
		const names = namesOf(installed)
		yield* admin.query(
			`ALTER TABLE ${names.table(A)} ADD FOREIGN KEY (package) REFERENCES ${names.table(P)} (package) ON DELETE CASCADE`,
			[]
		)
		yield* admin.query(`INSERT INTO ${names.table(P)} (package) VALUES ('p1'), ('p2')`, [])
		for (const [at, ops] of schedule.transactions.entries()) {
			const where = `transaction ${at} of ${Formatter.format(schedule)}`
			yield* session.begin
			const begun = yield* standingOf(installed, session)
			const found = new Set(Arr.map(begun, (r) => r.image))
			const moves: Moves = new Map()
			let ended = false
			let judgedOnce = false
			for (const op of ops) {
				if (op.kind === "judge") {
					c.noteAll(reachedAtJudge(moves))
					yield* newsOnce(installed, session, where)
					if (yield* judged(installed, session, where)) {
						c.note("refused by a rule")
						yield* session.rollback
						ended = true
						break
					}
					yield* session.query("SET CONSTRAINTS ALL DEFERRED", [])
					judgedOnce = true
					continue
				}
				const before = yield* standingOf(installed, session)
				yield* session.query(statementOf(installed, op), [])
				const after = yield* standingOf(installed, session)
				c.noteAll(reachedBy(op, before, after, found, moves))
				if (judgedOnce) {
					c.note("the judge run inside a transaction that writes on")
				}
			}
			if (ended) {
				continue
			}
			c.noteAll(reachedAtJudge(moves))
			yield* newsOnce(installed, session, where)
			if (yield* judged(installed, session, where)) {
				c.note("refused by a rule")
				yield* session.rollback
			} else {
				yield* session.commit
				c.note("committed")
			}
		}
	})

/** A case of indexTie: the rows sharing the touched row's prefix when first measured and the rows added after. */
export interface Tie {
	readonly few: number
	readonly more: number
	readonly governor: 1 | 2
	readonly statistics: "none" | "analyzed"
}

/**
 * The rows that share a prefix of the touched row's key: 2,000 rows or more, so A's primary key, over paths of about
 * 200 characters, is a B-tree of three levels where the index of (governor, name, package) is one of two.
 */
export const tieGen: Gen<Tie> = (s) => ({
	few: s.draw(int(2000, 3000)),
	more: s.draw(int(2000, 3000)),
	governor: s.draw(element([1, 2] as const)),
	statistics: s.draw(element(["none", "analyzed"] as const))
})

export type TieFeature = "measured with no statistics" | "measured analyzed"

/**
 * The statements loading attributes `from` to `to` of governor `governor`, all of one package and name, A's captures
 * off, and, of governor 1, their facts of Media, Media's captures off: Media is stored (`NetWrite`), and a load that
 * left its table without them would leave it short of its definition, as no installation keeps it, its upkeep's reads
 * of it measured over a table of none of the rows beside the touched one.
 */
const loaded = (
	installed: Installed,
	governor: number,
	from: number,
	to: number
): ReadonlyArray<string> => {
	const names = namesOf(installed)
	const path = "'doc/' || lpad(i::text, 8, '0') || '/' || repeat('x', 180)"
	const series = `FROM generate_series(${from}, ${to}) AS g(i)`
	const offWhile = (table: string, insert: string) => [
		`ALTER TABLE ${table} DISABLE TRIGGER USER`,
		insert,
		`ALTER TABLE ${table} ENABLE TRIGGER USER`
	]
	const media = names.table(Media)
	const fields = ["package", "path", "start", "name"] as const
	return [
		...offWhile(
			names.table(A),
			`INSERT INTO ${names.table(A)} (package, path, start, name, governor, note) SELECT 'pkg', ${path}, i, 7, ${governor}, 0 ${series}`
		),
		...(governor === 1
			? offWhile(
					media,
					`INSERT INTO ${media} (${Arr.join(
						Arr.map(fields, (f) => names.column(Media, f)),
						", "
					)}) SELECT 'pkg', ${path}, i, 7 ${series}`
				)
			: [])
	]
}

/**
 * The rows each statement the judge runs over the rows written reads, as EXPLAIN ANALYZE counts them over the deltas
 * that hold them, on `connection` (test/support/judge.ts judgeRun): Media's upkeep's DELETE and INSERT at the touched
 * row's key, run as phase A runs them and rolled back, and each probe over A's side of news or Media's, which the
 * upkeep's INSERT fills where the row is of governor 1.
 */
const readsOf = (installed: Installed, connection: PgConnection) =>
	Effect.map(
		judgeRun(
			(sql) => connection.queryValues(sql, []),
			installed.installation,
			judgeStatementsOf(installed.installation)
		),
		Arr.map((judged) => rowsRead(judged.plan))
	)

/**
 * One indexTie case in its one transaction, which the case's end rolls back, so no statistics outlive it and
 * autovacuum sees no row of it: `few` attributes of the touched row's package, name and governor loaded with A's
 * captures off, ANALYZE where the case draws it, the touched row's reference or declaration, then the touched row,
 * which its capture counts on A's side of news. Every statement the judge runs over it is explained over the deltas
 * that hold it, before the judge (`readsOf`), and the judge runs, accepting it, and runs again over the row taken back,
 * which empties the deltas; then `more` such attributes are loaded, the touched row put again, and each statement
 * explained again over it, and the judge runs. Each must read the same rows: a probe of Named reads the touched row
 * from A's side of news, never from A again, and Media's upkeep reads A at the touched row's whole key, never through
 * the index of its prefix. The measurement runs the upkeep's writes (test/support/judge.ts judgeRun), which stand in
 * the case's one transaction, so the row is judged and taken back before it is put and measured again, every table
 * beside the loaded rows as the first measurement found it.
 */
export const runTie = (
	installed: Installed,
	connection: PgConnection,
	tie: Tie,
	c: Case<TieFeature>
) =>
	Effect.gen(function* () {
		yield* standUpJudge(connection, installed.installation)
		const names = namesOf(installed)
		const a = names.table(A)
		const statistics = tie.statistics === "analyzed" ? [`ANALYZE ${a}`] : []
		const kept =
			tie.governor === 1
				? `INSERT INTO ${names.table(R)} (pack, path, start, name) VALUES ('pkg', 'doc/touched', 0, 7)`
				: `INSERT INTO ${names.table(Q)} (pack, name) VALUES ('pkg', 7)`
		const touched = `INSERT INTO ${a} (package, path, start, name, governor, note) VALUES ('pkg', 'doc/touched', 0, 7, ${tie.governor}, 0)`
		for (const sql of [
			...loaded(installed, tie.governor, 1, tie.few),
			...statistics,
			kept,
			touched
		]) {
			yield* connection.query(sql, [])
		}
		const first = yield* readsOf(installed, connection)
		assert.ok(first.length > 0, "a statement of the judge reads the touched row")
		for (const sql of [
			"SET CONSTRAINTS ALL IMMEDIATE",
			`DELETE FROM ${a} WHERE package = 'pkg' AND path = 'doc/touched' AND start = 0 AND name = 7`,
			"SET CONSTRAINTS ALL DEFERRED",
			...loaded(installed, tie.governor, tie.few + 1, tie.few + tie.more),
			...statistics,
			touched
		]) {
			yield* connection.query(sql, [])
		}
		const again = yield* readsOf(installed, connection)
		assert.deepEqual(
			again,
			first,
			`${Formatter.format(tie)}: each statement the judge runs over the touched row reads the same rows beside ${tie.more} more rows of its package, name and governor`
		)
		yield* connection.query("SET CONSTRAINTS ALL IMMEDIATE", [])
		c.note(tie.statistics === "none" ? "measured with no statistics" : "measured analyzed")
	})
