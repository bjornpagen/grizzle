import { pipe, String as Str } from "effect"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import {
	capacity,
	contained,
	key,
	mutable,
	on,
	relation,
	schema,
	within
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

const label = str.regex("^[a-z]{1,8}$")

/**
 * The put fixtures' Shop schema (test/unit/write/put/support.ts), declaration for declaration, built through the typed
 * public barrels, so the ChangeSets the explain suite builds over it carry their precise types: immutable and mutable
 * relations, a serial key, a serial field outside the key, a candidate key, an at-most-one capacity index, a residual
 * law and a pure set, all written by the clerk.
 */
export const Item = relation("Item", { id: uuid, label, qty: pg.bigint }, ["id"])
export const Stock = relation("Stock", { id: uuid, label, qty: pg.bigint }, ["id"])
export const Seat = relation("Seat", { no: pg.bigserial, label }, ["no"])
const Code = relation("Code", { id: uuid, code: label }, ["id"])
const Pair = relation("Pair", { a: uuid, b: label }, ["a", "b"])
const Counter = relation("Counter", { name: label, n: pg.bigint, seq: pg.serial }, ["name"])
const Line = relation("Line", { id: uuid, stock: uuid }, ["id"])
const Worker = relation("Worker", { id: uuid }, ["id"])
const Task = relation("Task", { id: uuid, worker: uuid }, ["id"])
const Crew = relation("Crew", { id: uuid }, ["id"])
const Hand = relation("Hand", { id: uuid, crew: uuid, label }, ["id"])

export const Shop = schema(
	"Shop",
	{ Item, Stock, Seat, Code, Pair, Counter, Line, Worker, Task, Crew, Hand },
	[
		mutable(Stock),
		mutable(Seat),
		mutable(Code),
		mutable(Pair),
		mutable(Counter),
		mutable(Task),
		mutable(Hand),
		key(on(Code, "code")),
		contained(on(Line, "stock"), on(Stock, "id")),
		contained(on(Task, "worker"), on(Worker, "id")),
		capacity(on(Worker, "id"), { from: on(Task, "worker"), within: within(0n, 1n) }),
		contained(on(Hand, "crew"), on(Crew, "id")),
		capacity(on(Crew, "id"), { from: on(Hand, "crew"), within: within(1n, 2n) })
	]
)

export const uuidOf = (n: number): Uuid =>
	`00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`
