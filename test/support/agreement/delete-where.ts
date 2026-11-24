import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Option, Record as Rec } from "effect"
import { catchCompileError } from "#compiler/core/canonical.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { writeWorldOf } from "#compiler/program/write-world.ts"
import { Num } from "#compiler/public/compute.ts"
import { Money, pg } from "#compiler/public/fields.ts"
import { param, query, v } from "#compiler/public/query.ts"
import { role } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { carrierScope } from "#compiler/sql/naming.ts"
import { changeSetOver as ChangeSet, changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import {
	Book,
	Budget,
	Cart,
	Cents,
	Item,
	Kind,
	Ledger,
	Line,
	Node,
	Tag,
	Task,
	Ticket,
	Work
} from "#test/support/agreement/changeset-schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { checking } from "#test/support/policy.ts"

/**
 * The deleteWhere box (test/types/changeset/delete-where.ts, test/unit/write/changeset/delete-where.test.ts): over the
 * ChangeSet agreement's Work (./changeset-schema.ts) and a role writing Task through a world entry, every relation a
 * deleteWhere key may name, each kind of delete among them (a plain relation, a tree's root, a family's owner, a
 * family's member, a member that owns a sequence, a world entry, a roster, a closed relation, refused), each with each
 * selection shape:
 * none, every field its delete's rows state as a parameter or as a literal, a field outside its rows, a parameter of
 * another type, a typed constant, a scalar term and a variable in place of a parameter. Each case's engine verdict is
 * the oracle: the JavaScript ChangeSet the case's text writes, built and compiled (deleteWhereVerdict).
 */

/** Manual tasks, a world entry over Task whose head leaves out the kind its selection fixes. */
const Manual = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	return r.match(Task, { id, account, kind: "Manual" }).find({ id, account })
})

/** A role writing Work's relations, Task through its Manual entry alone. */
export const Wherer = role(
	Work,
	"wherer",
	{ ...Work.relations, Manual },
	{
		insert: ["Order", "Line"],
		write: ["Manual", "Budget", "Ticket", "Ledger", "Tag", "Cart", "Entry"]
	}
)

/** A value a case writes: its text in the program, and the value the engine reads. */
interface Written {
	readonly text: string
	readonly value: () => unknown
}

/** A field a selection may name: its parameter, and its literal, none for a set. */
interface Selectable {
	readonly field: string
	readonly param: Written
	readonly literal: Option.Option<Written>
}

const uuidText = "00000000-0000-4000-8000-000000000001"

/** A parameter of a field, `param("p_<field>", R.fields.<field>)`, `make` making it by its name. */
const paramOf = (relation: string, field: string, make: (name: string) => unknown): Written => ({
	text: `param("p_${field}", ${relation}.fields.${field})`,
	value: () => make(`p_${field}`)
})

const literalOf = (text: string, value: unknown): Option.Option<Written> =>
	Option.some({ text, value: () => value })

/** A uuid's literal. */
const uuidLiteral = literalOf(`"${uuidText}"`, uuidText)

/** The relations a key may name, by the name the program spells them with. */
const subjects = [
	"Task",
	"Manual",
	"Budget",
	"Ticket",
	"Ledger",
	"Tag",
	"Order",
	"Cart",
	"Pool",
	"Bin",
	"Node",
	"Line",
	"Entry",
	"Item",
	"Chip",
	"Book",
	"Kind"
] as const
export type Subject = (typeof subjects)[number]

/** The fields of a subject's delete's rows. */
const rowFields = (s: Subject): ReadonlyArray<Selectable> => {
	switch (s) {
		case "Task":
		case "Manual":
			return [
				{
					field: "id",
					param: paramOf("Task", "id", (n) => param(n, Task.fields.id)),
					literal: uuidLiteral
				},
				{
					field: "account",
					param: paramOf("Task", "account", (n) => param(n, Task.fields.account)),
					literal: uuidLiteral
				},
				...(s === "Task"
					? [
							{
								field: "kind",
								param: paramOf("Task", "kind", (n) => param(n, Task.fields.kind)),
								literal: literalOf(`"Manual"`, "Manual")
							}
						]
					: [])
			]
		case "Budget":
			return [
				{
					field: "task",
					param: paramOf("Budget", "task", (n) => param(n, Budget.fields.task)),
					literal: uuidLiteral
				},
				{
					field: "cents",
					param: paramOf("Budget", "cents", (n) => param(n, Budget.fields.cents)),
					literal: literalOf("Cents(5n)", Cents(5n))
				}
			]
		case "Ticket":
			return [
				{
					field: "id",
					param: paramOf("Ticket", "id", (n) => param(n, Ticket.fields.id)),
					literal: literalOf("3n", 3n)
				},
				{
					field: "account",
					param: paramOf("Ticket", "account", (n) => param(n, Ticket.fields.account)),
					literal: uuidLiteral
				},
				{
					field: "amount",
					param: paramOf("Ticket", "amount", (n) => param(n, Ticket.fields.amount)),
					literal: literalOf("Cents(7n)", Cents(7n))
				}
			]
		case "Ledger":
			return [
				{
					field: "id",
					param: paramOf("Ledger", "id", (n) => param(n, Ledger.fields.id)),
					literal: literalOf("4n", 4n)
				},
				{
					field: "balance",
					param: paramOf("Ledger", "balance", (n) => param(n, Ledger.fields.balance)),
					literal: literalOf("-9n", -9n)
				},
				{
					field: "fee",
					param: paramOf("Ledger", "fee", (n) => param(n, Ledger.fields.fee)),
					literal: literalOf("Money.of(250n)", Money.of(250n))
				}
			]
		case "Tag":
			return [
				{
					field: "id",
					param: paramOf("Tag", "id", (n) => param(n, Tag.fields.id)),
					literal: uuidLiteral
				},
				{
					field: "kind",
					param: paramOf("Tag", "kind", (n) => param(n, Tag.fields.kind)),
					literal: literalOf(`"Automatic"`, "Automatic")
				},
				{
					field: "flags",
					param: paramOf("Tag", "flags", (n) => param(n, Tag.fields.flags)),
					literal: Option.none()
				},
				{
					field: "answer",
					param: paramOf("Tag", "answer", (n) => param(n, Tag.fields.answer)),
					literal: literalOf(`"yes"`, "yes")
				},
				{
					field: "grade",
					param: paramOf("Tag", "grade", (n) => param(n, Tag.fields.grade)),
					literal: literalOf(`"pass"`, "pass")
				}
			]
		case "Order":
		case "Cart":
		case "Pool":
		case "Bin":
			return [
				{
					field: "id",
					param: paramOf(s, "id", (n) => param(n, Cart.fields.id)),
					literal: uuidLiteral
				}
			]
		case "Node":
			return [
				{
					field: "doc",
					param: paramOf("Node", "doc", (n) => param(n, Node.fields.doc)),
					literal: uuidLiteral
				}
			]
		case "Line":
		case "Entry":
			return [
				{
					field: "owner",
					param: paramOf(s, "owner", (n) => param(n, Line.fields.owner)),
					literal: uuidLiteral
				},
				{
					field: "qty",
					param: paramOf(s, "qty", (n) => param(n, Line.fields.qty)),
					literal: literalOf("2n", 2n)
				}
			]
		case "Item":
		case "Chip":
			return [
				{
					field: "owner",
					param: paramOf(s, "owner", (n) => param(n, Item.fields.owner)),
					literal: uuidLiteral
				},
				{
					field: "v",
					param: paramOf(s, "v", (n) => param(n, Item.fields.v)),
					literal: literalOf("2n", 2n)
				}
			]
		case "Book":
			return [
				{
					field: "id",
					param: paramOf("Book", "id", (n) => param(n, Book.fields.id)),
					literal: uuidLiteral
				},
				{
					field: "shelf",
					param: paramOf("Book", "shelf", (n) => param(n, Book.fields.shelf)),
					literal: uuidLiteral
				}
			]
		case "Kind":
			return [
				{
					field: "id",
					param: {
						text: `param("p_id", Task.fields.kind)`,
						value: () => param("p_id", Task.fields.kind)
					},
					literal: literalOf(`"Manual"`, "Manual")
				}
			]
	}
}

/** A field the subject holds outside its delete's rows, which no selection names: a drawn, generated or non-root field. */
const outsideField = (s: Subject): Option.Option<Selectable> => {
	switch (s) {
		case "Order":
		case "Cart":
			return Option.some({
				field: "total",
				param: paramOf(s, "total", (n) => param(n, Cart.fields.total)),
				literal: Option.none()
			})
		case "Node":
			return Option.some({
				field: "label",
				param: paramOf("Node", "label", (n) => param(n, Node.fields.label)),
				literal: Option.none()
			})
		case "Item":
		case "Chip":
			return Option.some({
				field: "next",
				param: paramOf(s, "next", (n) => param(n, pg.bigint)),
				literal: Option.none()
			})
		case "Task":
		case "Manual":
		case "Budget":
		case "Ticket":
		case "Ledger":
		case "Tag":
		case "Pool":
		case "Bin":
		case "Line":
		case "Entry":
		case "Book":
		case "Kind":
			return Option.none()
	}
}

/** A selection's shape. */
const shapes = [
	"none",
	"parameters",
	"literals",
	"a field outside its rows",
	"a parameter of another type",
	"a typed constant",
	"a scalar term",
	"a variable"
] as const
type Shape = (typeof shapes)[number]

/** A case: a subject and a selection shape. */
export interface DeleteWhereCase {
	readonly subject: Subject
	readonly shape: Shape
}

/** A selection's fields: each its name and the value written for it. */
type Fields = ReadonlyArray<readonly [string, Written]>

/** The fields a case's selection writes, none where its shape has no field of the subject to write. */
const fieldsOf = (c: DeleteWhereCase): Option.Option<Fields> => {
	const row = rowFields(c.subject)
	const first = row[0]
	switch (c.shape) {
		case "none":
			return Option.some([])
		case "parameters":
			return Option.some(Arr.map(row, (f) => [f.field, f.param] as const))
		case "literals":
			return Option.some(
				Arr.map(row, (f) => [f.field, Option.getOrElse(f.literal, () => f.param)] as const)
			)
		case "a field outside its rows":
			return Option.map(outsideField(c.subject), (f) => [[f.field, f.param] as const])
		case "a parameter of another type":
			return first === undefined
				? Option.none()
				: Option.some([
						[
							first.field,
							{ text: `param("q", pg.boolean)`, value: () => param("q", pg.boolean) }
						] as const
					])
		case "a typed constant": {
			const kind = Arr.findFirst(row, (f) => f.field === "kind")
			return Option.map(kind, (f) => [
				[f.field, { text: `Kind.handle("Manual")`, value: () => Kind.handle("Manual") }] as const
			])
		}
		case "a scalar term": {
			const bigint = Arr.findFirst(row, (f) => f.field === "balance" || f.field === "id")
			return c.subject === "Ledger"
				? Option.map(bigint, (f) => [
						[
							f.field,
							{
								text: `Num.add(param("q", pg.bigint), 1n)`,
								value: () => Num.add(param("q", pg.bigint), 1n)
							}
						] as const
					])
				: Option.none()
		}
		case "a variable":
			return c.subject === "Task"
				? Option.some([["account", { text: "t.account", value: () => undefined }] as const])
				: Option.none()
	}
}

/** Every case of the box: each subject with each shape it has fields for. */
export const deleteWhereCases: ReadonlyArray<DeleteWhereCase> = Arr.flatMap(subjects, (subject) =>
	Arr.filter(
		Arr.map(shapes, (shape): DeleteWhereCase => ({ subject, shape })),
		(c) => Option.isSome(fieldsOf(c))
	)
)

/** What a case's ChangeSet is over: the role for its world entry, Work otherwise. */
const overOf = (s: Subject): "Wherer" | "Work" => (s === "Manual" ? "Wherer" : "Work")

/** A case's selection, as the program writes it. */
const selectionText = (fields: Fields): string =>
	`{ ${Arr.join(
		Arr.map(fields, ([f, w]) => `${f}: ${w.text}`),
		", "
	)} }`

/** A case's deleteWhere call, as the program writes it after `ChangeSet.empty(<over>)`. */
export const callText = (c: DeleteWhereCase): string =>
	`.deleteWhere({ ${c.subject}: ${selectionText(Option.getOrThrow(fieldsOf(c)))} })`

/** Whether a case's deleteWhere is over the role. */
export const overText = (c: DeleteWhereCase): string => overOf(c.subject)

/** What a ChangeSet over Work and over the role compile against. */
const worlds = (() => {
	const work = succeeded(testArtifacts(Work, testCompile))
	const wherer = succeeded(testArtifacts(Wherer, testCompile))
	const world = wherer.world
	if (world.kind !== "role") {
		return assert.fail("the role's artifacts hold its world")
	}
	return {
		Work: { checked: checking(Work), options: realityWrite(work) },
		Wherer: {
			checked: world.checked,
			options: {
				names: wherer.names,
				reads: wherer.reads,
				claims: { kind: "every" } as const,
				world: writeWorldOf(world, wherer.laws),
				laws: wherer.laws,
				derived: wherer.derived,
				level: "serializable" as const,
				clock: noClock,
				source: transactionClock,
				carrierScope: carrierScope(world.role.name)
			}
		}
	}
})()

/** A case's ChangeSet as the engine builds and compiles it: whether it is refused, and the reason when it is. */
export const deleteWhereVerdict = (
	c: DeleteWhereCase
): { readonly kind: "admitted" } | { readonly kind: "refused"; readonly reason: string } => {
	const fields = Option.getOrThrow(fieldsOf(c))
	const over = overOf(c.subject)
	const run = () => {
		const record = (values: ReadonlyArray<readonly [string, unknown]>) =>
			ChangeSet.empty(over === "Wherer" ? Wherer : Work).deleteWhere({
				[c.subject]: Rec.fromEntries(values)
			})
		if (c.shape === "a variable") {
			const built: Array<unknown> = []
			queryOver(Work).rule((r: RuleValue) => {
				const t = varsOver(Task, "t")
				built.push(record([["account", t["account"]]]))
				return r.match(Task, t).find(t)
			})
			return built[0]
		}
		return record(Arr.map(fields, ([f, w]) => [f, w.value()] as const))
	}
	const built = catchCompileError(run)
	if (!built.ok) {
		return { kind: "refused", reason: built.error.reason._tag }
	}
	const { checked, options } = worlds[over]
	const compiled = compileWrite(
		checked,
		defined(changeSetDesc(built.value), "a ChangeSet"),
		options
	)
	return compiled.ok
		? { kind: "admitted" }
		: { kind: "refused", reason: compiled.error.reason._tag }
}
