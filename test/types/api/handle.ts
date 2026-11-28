import { Array as Arr, Effect, String as Str } from "effect"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/support/types/batch/batch.ts"

/**
 * The member-handle program: the box of every kind of served program a handle runs (a query, a paged ordered query, a
 * relation's key, an answered(...) query, paged query and key, a ChangeSet of query members and
 * one of array members), each kind twice, two programs of distinct types over one level, both served to a role of that
 * level and to a role of a level that extends it, by every pairing of a function over MemberHandle<typeof p> with a
 * handle, exhausted and printed as one program the type batch checks.
 *
 * The oracle: a handle is admitted exactly when its program is the function's own, whichever login's role holds it, a
 * role over the level or over its extension; the handle of the kind's other program is refused. Each pairing states
 * its verdict as a type the program must hold, and each admitted handle is also passed to the function, so the program
 * typechecks clean exactly when every verdict holds. Each read kind's explain fails as its once does, with CallError.
 * Each kind's handle holds a `watch` exactly where its program is live: an answered read's holds `once` alone, so a
 * watch of it is a type error. Each pairing is a cell of the box, and so is each read kind's explain and each kind's
 * watch; the level, its programs and the Dbs are the batch's own.
 */

/** The kinds of program a served member's handle runs, each with its two programs' declarations. */
const kinds = [
	"query",
	"paged",
	"key",
	"answered",
	"answeredPaged",
	"answeredKey",
	"change",
	"facts"
] as const

/** The read kinds, each with the error its explain fails with. */
const readErrors: Arr.NonEmptyReadonlyArray<readonly [Kind, string]> = [
	["query", "CallError"],
	["paged", "CallError"],
	["key", "CallError"],
	["answered", "CallError"],
	["answeredPaged", "CallError"],
	["answeredKey", "CallError"]
]

/** Whether each kind's handle holds a watch: every kind's but an answered read's, whose program is never live. */
const watches: { readonly [K in Kind]: boolean } = {
	query: true,
	paged: true,
	key: true,
	answered: false,
	answeredPaged: false,
	answeredKey: false,
	change: true,
	facts: true
}

type Kind = (typeof kinds)[number]

/** Each kind's two programs over Root, of distinct types: the first over Item, the second over Note. */
const programsOf: { readonly [K in Kind]: readonly [string, string] } = {
	query: [
		`query(Root).rule((r) => {
	const { id, label } = v(Item, "item")
	return r.match(Item, { id, label }).find({ id, label })
})`,
		`query(Root).rule((r) => {
	const { id, count } = v(Note, "note")
	return r.match(Note, { id, count }).find({ id, count })
})`
	],
	paged: [
		`paged(
	query(Root)
		.rule((r) => {
			const { id, label } = v(Item, "item")
			return r.match(Item, { id, label }).find({ id, label })
		})
		.orderBy(["id", "asc"])
)`,
		`paged(
	query(Root)
		.rule((r) => {
			const { id, count } = v(Note, "note")
			return r.match(Note, { id, count }).find({ id, count })
		})
		.orderBy(["id", "asc"])
)`
	],
	key: ["Item", "Note"],
	answered: [
		`answered(
	query(Root).rule((r) => {
		const { id, label } = v(Item, "item")
		return r.match(Item, { id, label }).find({ id, label })
	})
)`,
		`answered(
	query(Root).rule((r) => {
		const { id, count } = v(Note, "note")
		return r.match(Note, { id, count }).find({ id, count })
	})
)`
	],
	answeredPaged: [
		`answered(
	paged(
		query(Root)
			.rule((r) => {
				const { id, label } = v(Item, "item")
				return r.match(Item, { id, label }).find({ id, label })
			})
			.orderBy(["id", "asc"])
	)
)`,
		`answered(
	paged(
		query(Root)
			.rule((r) => {
				const { id, count } = v(Note, "note")
				return r.match(Note, { id, count }).find({ id, count })
			})
			.orderBy(["id", "asc"])
	)
)`
	],
	answeredKey: ["answered(Item)", "answered(Note)"],
	change: [
		`ChangeSet.empty(Root).insert(
	Item,
	query(Root).rule((r) => {
		const rows = r.relation("items", { id: Item.fields.id, label: Item.fields.label })
		const { id, label } = v(Item, "item")
		return r.match(rows, { id, label }).find({ id, label })
	})
)`,
		`ChangeSet.empty(Root).insert(
	Note,
	query(Root).rule((r) => {
		const rows = r.relation("notes", { id: Note.fields.id, count: Note.fields.count })
		const { id, count } = v(Note, "note")
		return r.match(rows, { id, count }).find({ id, count })
	})
)`
	],
	facts: ["ChangeSet.empty(Root).insert(Item, [])", "ChangeSet.empty(Root).insert(Note, [])"]
}

/** The Dbs a case reads a handle off: a role of the level that declares the programs, and a role of its extension. */
const dbs = ["atLevel", "atExtension"] as const

/** The member each kind's programs are served under, the first as `<kind>0`, the second as `<kind>1`. */
const memberOf = (kind: Kind, which: 0 | 1): string => `${kind}${which}`

/** One pairing: the kind, the Db, and whether the handle is the function's own program's. */
interface Pairing {
	readonly kind: Kind
	readonly db: (typeof dbs)[number]
	readonly own: boolean
}

/** Every kind by every Db by the function's own program's handle and the other's. */
const pairings: Arr.NonEmptyReadonlyArray<Pairing> = Arr.flatMap(kinds, (kind) =>
	Arr.flatMap(dbs, (db) => Arr.map([true, false] as const, (own): Pairing => ({ kind, db, own })))
)

/**
 * A cell of the box: a pairing, a read kind's explain and the error it fails with, or a kind's handle and whether it
 * holds a watch.
 */
type HandleCell =
	| Readonly<{ kind: "pairing"; pairing: Pairing }>
	| Readonly<{ kind: "explain"; read: Kind; error: string }>
	| Readonly<{ kind: "watch"; program: Kind; watches: boolean }>

/** The cells of handleBox, minted as a dictionary in its door (test/types/api/handle.dictionary.ts). */
export const handleBoxItems: Arr.NonEmptyReadonlyArray<HandleCell> = [
	...Arr.map(pairings, (pairing): HandleCell => ({ kind: "pairing", pairing })),
	...Arr.map(readErrors, ([read, error]): HandleCell => ({ kind: "explain", read, error })),
	...Arr.map(kinds, (program): HandleCell => ({
		kind: "watch",
		program,
		watches: watches[program]
	}))
]

/**
 * A pairing's verdict, stated as the box's oracle gives it, and, for its own program's handle, the call of the
 * function over MemberHandle that takes it.
 */
const pairingLines = (p: Pairing, index: number): ReadonlyArray<string> => {
	const handle = `${p.db}.workload.${memberOf(p.kind, p.own ? 0 : 1)}`
	const verdict = `export type v${index} = Expect<Equals<Takes<typeof ${memberOf(p.kind, 0)}, typeof ${handle}>, ${
		p.own ? '"admitted"' : '"refused"'
	}>>`
	return p.own
		? [
				`// ${p.kind}: its own program's handle, off ${p.db}`,
				verdict,
				`export const h${index} = takes_${p.kind}(${handle})`
			]
		: [`// ${p.kind}: the other program's handle, off ${p.db}`, verdict]
}

/** A cell's lines. */
const cellLines = (cell: HandleCell, index: number): ReadonlyArray<string> => {
	switch (cell.kind) {
		case "pairing":
			return pairingLines(cell.pairing, index)
		case "explain":
			return [
				`export type e${index} = Expect<Equals<Effect.Error<ReturnType<typeof atLevel.workload.${memberOf(cell.read, 0)}.explain>>, ${cell.error}>>`
			]
		case "watch":
			return [
				`export type w${index} = Expect<Equals<"watch" extends keyof typeof atLevel.workload.${memberOf(cell.program, 0)} ? true : false, ${cell.watches}>>`
			]
	}
}

/** The program's prelude (test/support/programs/handles.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/handles.ts"))

/** The level, its programs, the workload serving them and the Dbs over it: every cell reads them. */
const handleHeader: ReadonlyArray<string> = [
	'export const Item = relation("Item", { id: Id, label: pg.integer }, ["id"])',
	'export const Note = relation("Note", { id: Id, count: pg.bigint }, ["id"])',
	'export const Extra = relation("Extra", { id: Id }, ["id"])',
	'export const Root = schema("Root", [Item, Note], [])',
	'export const Wider = schema.extend([Root], "Wider", [Extra], [])',
	'export const level = role(Root, "level", wholeEntriesOf(Root))',
	'export const extension = role(Wider, "extension", wholeEntriesOf(Wider))',
	...Arr.flatMap(kinds, (kind) =>
		Arr.flatMap([0, 1] as const, (which) =>
			Str.split(`export const ${memberOf(kind, which)} = ${programsOf[kind][which]}`, "\n")
		)
	),
	`export const served = workload(Root, { ${Arr.join(
		Arr.flatMap(kinds, (kind) => [memberOf(kind, 0), memberOf(kind, 1)]),
		", "
	)} })`,
	"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"export type Expect<T extends true> = T",
	"/** Whether a handle H is one a function over MemberHandle<X> takes. */",
	'export type Takes<X, H> = [H] extends [MemberHandle<X>] ? "admitted" : "refused"',
	"export declare const atLevel: Db<typeof level, typeof served.programs>",
	"export declare const atExtension: Db<typeof extension, typeof served.programs>",
	...Arr.map(
		kinds,
		(kind) =>
			`export const takes_${kind} = (handle: MemberHandle<typeof ${memberOf(kind, 0)}>): MemberHandle<typeof ${memberOf(kind, 0)}> => handle`
	),
	""
]

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const handleProgram = (
	cells: Arr.NonEmptyReadonlyArray<HandleCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/api/handle.ts: member handles against their programs.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: handleHeader },
			...Arr.map(cells, (cell, at) => ({ owner: caseOwned(at), lines: cellLines(cell, at) }))
		]
	)
]
