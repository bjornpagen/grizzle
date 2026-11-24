import { Array as Arr, Effect } from "effect"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import { batchOwned, caseOwned, type Entry, type Program } from "#test/types/batch/batch.ts"

/**
 * The roster-in program: a sitting's status, a closed id of the five-handle roster Status, and the status it mirrors,
 * read by a rule whose WHERE restricts the status by a membership test, r.in or Logic.in, standing alone, in a
 * conjunction, in a disjunction, twice, as one of two predicates either of which may run, or over a text term, and the
 * head finding the status or a variable equated with it. The box is those filters.
 *
 * The oracle is the specification, the WHERE itself: every row a filter keeps holds a handle the WHERE admits, so the
 * found status is the union of the handles every test restricting it lists (their intersection where two hold at once,
 * their union where either may run), a variable equated with it alike, and the whole roster where a disjunction states
 * nothing; a text term keeps its type, which no list of literals bounds.
 */

/** A filter the box holds: its name, the WHERE's predicates as written, the field the head finds and its found type. */
interface FilterCell {
	readonly name: string
	readonly where: string
	readonly found: "status" | "mirror" | "label"
	readonly type: string
}

const everyHandle = '"ASSIGNED" | "IN_PROGRESS" | "PAUSED" | "COMPLETED" | "ABANDONED"'

/** The cells of rosterInBox, minted as a dictionary in its door (test/types/query/roster-in.dictionary.ts). */
export const rosterInBoxItems: Arr.NonEmptyReadonlyArray<FilterCell> = [
	{
		name: "r.in alone",
		where: 'r.in(status, ["ASSIGNED", "IN_PROGRESS", "PAUSED", "COMPLETED"])',
		found: "status",
		type: '"ASSIGNED" | "IN_PROGRESS" | "PAUSED" | "COMPLETED"'
	},
	{
		name: "Logic.in alone",
		where: 'Logic.in(status, ["PAUSED"])',
		found: "status",
		type: '"PAUSED"'
	},
	{
		name: "r.in in a conjunction",
		where: 'r.and(r.in(status, ["ASSIGNED", "PAUSED"]), r.eq(number, 1))',
		found: "status",
		type: '"ASSIGNED" | "PAUSED"'
	},
	{
		name: "r.in in a disjunction",
		where: 'r.or(r.in(status, ["ASSIGNED"]), r.eq(number, 1))',
		found: "status",
		type: everyHandle
	},
	{
		name: "two tests at once",
		where:
			'r.in(status, ["ASSIGNED", "PAUSED", "COMPLETED"]), r.in(status, ["PAUSED", "COMPLETED", "ABANDONED"])',
		found: "status",
		type: '"PAUSED" | "COMPLETED"'
	},
	{
		name: "either of two tests",
		where: 'either ? r.in(status, ["ASSIGNED"]) : r.in(status, ["PAUSED"])',
		found: "status",
		type: '"ASSIGNED" | "PAUSED"'
	},
	{
		name: "an equated variable",
		where: 'r.in(status, ["ASSIGNED", "COMPLETED"]), r.eq(mirror, status)',
		found: "mirror",
		type: '"ASSIGNED" | "COMPLETED"'
	},
	{
		name: "a text term",
		where: 'r.in(label, ["first", "second"])',
		found: "label",
		type: "string"
	}
]

/** The schema every cell reads: the roster, and the sittings holding a status, its mirror and a label. */
const rosterInHeader = (): ReadonlyArray<string> => [
	'export const Status = closed.ordered("Status", ["ASSIGNED", "IN_PROGRESS", "PAUSED", "COMPLETED", "ABANDONED"])',
	'export const Label = str.regex("^[a-z]{1,16}$")',
	'export const Sitting = relation("Sitting", { number: pg.integer, status: closedId(Status), mirror: closedId(Status), label: Label }, ["number"])',
	'export const Sittings = schema("Sittings", [Status, Sitting], [])',
	"export declare const either: boolean",
	"export type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"export type Expect<T extends true> = T",
	""
]

/** A cell's lines: the rule under its filter, its found field the cell's type, and never the type a missed filter leaves. */
const cellLines = (c: FilterCell, at: number): ReadonlyArray<string> => [
	`// ${c.name}`,
	`export const read${at} = query(Sittings).rule((r) => {`,
	'\tconst { number, status, mirror, label } = v(Sitting, "sitting")',
	`\treturn r.match(Sitting, { number, status, mirror, label }).where(${c.where}).find({ number, ${c.found} })`,
	"})",
	`export type found${at} = Expect<Equals<HeadOf<typeof read${at}>["${c.found}"], ${c.type}>>`,
	...(c.type === everyHandle || c.type === "string"
		? [
				`// @ts-expect-error -- refused: a filter that states nothing narrows nothing`,
				`export type narrower${at} = Expect<Equals<HeadOf<typeof read${at}>["${c.found}"], "ASSIGNED">>`
			]
		: [
				`// @ts-expect-error -- refused: the found ${c.found} holds no handle its filter keeps out`,
				`export type wider${at} = Expect<Equals<HeadOf<typeof read${at}>["${c.found}"], ${everyHandle}>>`
			]),
	""
]

/** The program's prelude (test/support/programs/roster-in.ts). */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/roster-in.ts"))

/** The program over a batch's cells, its imports read through its prelude as `entry` reaches it. */
export const rosterInProgram = (
	cells: Arr.NonEmptyReadonlyArray<FilterCell>,
	entry: Entry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/types/query/roster-in.ts: a roster term's found type under the WHERE's membership tests.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: rosterInHeader() },
			...Arr.map(cells, (c, at) => ({ owner: caseOwned(at), lines: cellLines(c, at) }))
		]
	)
]
