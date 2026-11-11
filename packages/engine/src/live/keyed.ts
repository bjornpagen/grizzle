import { defect } from "#compiler/core/invariant.ts"
import { TupleMap } from "#compiler/core/tuple-map.ts"
import type { ListChange, ReadShape, SetChange } from "#compiler/live/events.ts"
import { type Form, formOf, type KeyFields, keyOf, type RowKey } from "#compiler/live/key.ts"

/** One row of a read's value: its key, the key's form, and the row. */
export interface Entry<Row> {
	readonly key: RowKey
	readonly form: Form
	readonly row: Row
}

/** An entry as its value links it into order, which only the value that holds it changes, before it is shared. */
interface Node<Row> extends Entry<Row> {
	row: Row
	prev: Node<Row> | undefined
	next: Node<Row> | undefined
}

/**
 * A read's value: its rows by key (keyOf under its key fields), in order. A set's order is the order its keys arrived
 * in, which says nothing; a list's is the program's. A value is never changed once shared: applying changes to it
 * answers a new value (applying), so a caller may hold every value it was given.
 */
export class Keyed<S extends ReadShape, Row extends object> implements Iterable<Row> {
	readonly shape: S
	readonly fields: KeyFields
	readonly #nodes = new TupleMap<Form, Node<Row>>()
	#head: Node<Row> | undefined = undefined
	#tail: Node<Row> | undefined = undefined

	private constructor(shape: S, fields: KeyFields) {
		this.shape = shape
		this.fields = fields
	}

	/** The value of shape `shape` with no row, keyed by `fields`. */
	static empty<S extends ReadShape, Row extends object>(
		shape: S,
		fields: KeyFields
	): Keyed<S, Row> {
		return new Keyed<S, Row>(shape, fields)
	}

	/**
	 * The value of shape `shape` keyed by `fields` holding `rows`, in their order: a run's rows, which its key keys, so
	 * two rows of one key are a defect of the key the served file names.
	 */
	static of<S extends ReadShape, Row extends object>(
		shape: S,
		fields: KeyFields,
		rows: Iterable<Row>
	): Keyed<S, Row> {
		const value = new Keyed<S, Row>(shape, fields)
		for (const row of rows) {
			const key = keyOf(fields, row)
			const form = formOf(key)
			if (value.#nodes.has(form)) {
				throw defect("a read delivered two rows of one key: its served key fields are no key")
			}
			value.#link({ key, form, row, prev: undefined, next: undefined }, value.#tail)
		}
		return value
	}

	get size(): number {
		return this.#nodes.size
	}

	/** The entry whose key has the form `form`, none where no row's does. */
	at(form: Form): Entry<Row> | undefined {
		return this.#nodes.get(form)
	}

	/** The row of `key`, none where no row has it. */
	get(key: RowKey): Row | undefined {
		return this.#nodes.get(formOf(key))?.row
	}

	/** Every entry, in order. */
	*entries(): IterableIterator<Entry<Row>> {
		for (let node = this.#head; node !== undefined; node = node.next) {
			yield node
		}
	}

	*[Symbol.iterator](): IterableIterator<Row> {
		for (let node = this.#head; node !== undefined; node = node.next) {
			yield node.row
		}
	}

	/**
	 * This value with `changes` applied in order, a new value: a remove takes its key's row out, where there is one; an
	 * upsert of an ordered read places its row after the row of its `after` key, first for null, the row of its key
	 * moved there if present; an upsert of a set read replaces its key's row in place, or adds the row last. An `after`
	 * no row of the value has, or the upserted row's own, is a defect of the stream.
	 */
	applying(changes: Iterable<SetChange<Row> | ListChange<Row>>): Keyed<S, Row> {
		const value = new Keyed<S, Row>(this.shape, this.fields)
		for (let node = this.#head; node !== undefined; node = node.next) {
			value.#link({ ...node, prev: undefined, next: undefined }, value.#tail)
		}
		for (const change of changes) {
			if (change.kind === "remove") {
				value.#remove(formOf(change.key))
			} else if ("after" in change) {
				value.#place(change.row, change.after)
			} else {
				value.#replace(change.row)
			}
		}
		return value
	}

	/** Links `node` after `prev`, first where none, and indexes it. */
	#link(node: Node<Row>, prev: Node<Row> | undefined): void {
		const next = prev === undefined ? this.#head : prev.next
		node.prev = prev
		node.next = next
		if (prev === undefined) {
			this.#head = node
		} else {
			prev.next = node
		}
		if (next === undefined) {
			this.#tail = node
		} else {
			next.prev = node
		}
		this.#nodes.set(node.form, node)
	}

	/** Unlinks `node` and drops its index. */
	#unlink(node: Node<Row>): void {
		if (node.prev === undefined) {
			this.#head = node.next
		} else {
			node.prev.next = node.next
		}
		if (node.next === undefined) {
			this.#tail = node.prev
		} else {
			node.next.prev = node.prev
		}
		this.#nodes.delete(node.form)
	}

	#remove(form: Form): void {
		const node = this.#nodes.get(form)
		if (node !== undefined) {
			this.#unlink(node)
		}
	}

	#replace(row: Row): void {
		const key = keyOf(this.fields, row)
		const form = formOf(key)
		const node = this.#nodes.get(form)
		if (node === undefined) {
			this.#link({ key, form, row, prev: undefined, next: undefined }, this.#tail)
		} else {
			node.row = row
		}
	}

	#place(row: Row, after: RowKey | null): void {
		const key = keyOf(this.fields, row)
		const form = formOf(key)
		this.#remove(form)
		const prev = after === null ? undefined : this.#nodes.get(formOf(after))
		if (after !== null && prev === undefined) {
			throw defect("an ordered upsert follows a key its value does not hold")
		}
		this.#link({ key, form, row, prev: undefined, next: undefined }, prev)
	}
}

/** A set read's value. */
export type KeyedSet<Row extends object> = Keyed<"set", Row>

/** An ordered read's value. */
export type KeyedList<Row extends object> = Keyed<"list", Row>
