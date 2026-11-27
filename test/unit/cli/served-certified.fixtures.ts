/** What the properties of served-certified.test.ts read: its spaces, models and helpers. */

import { element, type Gen, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter } from "effect"
import { wholeWritesOf } from "#compiler/public/schema.ts"
import {
	Budget,
	Node,
	Order,
	Pool,
	Tag,
	Task,
	Ticket,
	Work
} from "#test/support/agreement/changeset-schema.ts"
import { repoRoot } from "#test/support/files.ts"

type Mode = "insert" | "write"

/**
 * A relation of Work a writer may insert, with every relation its insert writes, which the writer's list must hold: a
 * family owner's members with it.
 */
interface Written {
	readonly name: string
	readonly relation:
		| typeof Tag
		| typeof Ticket
		| typeof Budget
		| typeof Task
		| typeof Order
		| typeof Pool
		| typeof Node
	readonly writes: Arr.NonEmptyReadonlyArray<string>
}

const written: Arr.NonEmptyReadonlyArray<Written> = [
	{ name: "Tag", relation: Tag, writes: ["Tag"] },
	{ name: "Ticket", relation: Ticket, writes: ["Ticket"] },
	{ name: "Budget", relation: Budget, writes: ["Budget"] },
	{ name: "Task", relation: Task, writes: ["Task"] },
	{ name: "Order", relation: Order, writes: ["Order", "Line"] },
	{ name: "Pool", relation: Pool, writes: ["Pool", "Item"] },
	{ name: "Node", relation: Node, writes: ["Node"] }
]

/** A direct writer: none, or a role with no change member that inserts, or writes, `writes`. */
type Direct =
	| { readonly kind: "none" }
	| { readonly kind: Mode; readonly writes: Arr.NonEmptyReadonlyArray<Written> }

interface Case {
	readonly mode: Mode
	readonly writes: Arr.NonEmptyReadonlyArray<Written>
	readonly inserts: Arr.NonEmptyReadonlyArray<Written>
	readonly direct: Direct
}

/** A nonempty subset of `values`: one drawn, and any others beside it, in the order `values` holds them. */
const nonEmptySubset =
	<A>(values: Arr.NonEmptyReadonlyArray<A>): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(source) => {
		const first = source.draw(element(values))
		const rest = source.draw(subarray(values))
		return [first, ...Arr.filter(rest, (v) => v !== first)]
	}

export const caseGen: Gen<Case> = (source) => {
	const mode = source.draw(element<Mode>(["insert", "write"]))
	const writes = source.draw(nonEmptySubset(written))
	const inserts = source.draw(nonEmptySubset(writes))
	const direct = source.draw(element<Direct["kind"]>(["none", "insert", "write"]))
	return {
		mode,
		writes,
		inserts,
		direct:
			direct === "none"
				? { kind: "none" }
				: { kind: direct, writes: source.draw(nonEmptySubset(written)) }
	}
}

export type Feature =
	| "an insert role"
	| "a write role"
	| "a role certified READ COMMITTED"
	| "a role certified SERIALIZABLE for its own statements"
	| "a role with no change member"
	| "a direct writer of a relation the writer writes"
	| "a READ COMMITTED role served from the snapshot alone"

export const file = `${repoRoot}app/grizzle.config.ts`

/** How a case prints: each relation by its name. */
export const showCase = (c: Case): string => {
	const list = (ws: ReadonlyArray<Written>) =>
		`[${Arr.join(
			Arr.map(ws, (w) => Formatter.format(w.name)),
			", "
		)}]`
	const direct =
		c.direct.kind === "none"
			? `{ kind: "none" }`
			: `{ kind: ${Formatter.format(c.direct.kind)}, writes: ${list(c.direct.writes)} }`
	return `{ mode: ${Formatter.format(c.mode)}, writes: ${list(c.writes)}, inserts: ${list(c.inserts)}, direct: ${direct} }`
}

/**
 * A role's lists over what `written` writes, as `mode` states them: every name under the insert list, or, writing, each
 * of Work's open relations under the write list and each closed one under the insert list, which no write list names.
 */
export const listsOf = (
	mode: Mode,
	written: ReadonlyArray<Written>
): { readonly insert: ReadonlyArray<string>; readonly write: ReadonlyArray<string> } => {
	const names = Arr.flatMap(written, (w) => w.writes)
	const open = wholeWritesOf(Work).write
	return mode === "insert"
		? { insert: names, write: [] }
		: {
				insert: Arr.filter(names, (n) => !Arr.some(open, (o) => o === n)),
				write: Arr.filter(names, (n) => Arr.some(open, (o) => o === n))
			}
}
