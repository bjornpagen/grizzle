import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Context, Option } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Carrier, ScalarType } from "#compiler/ir/scalar.ts"
import {
	carrierTwins,
	type SpelledValue,
	spelledAt,
	twinsOf
} from "#test/support/oracle/gen/domain.ts"
import { InputSpelling } from "#test/support/oracle/install/literal.ts"
import { elementAt } from "#test/support/oracle/pick.ts"

/**
 * How a case's facts are stored otherwise, every value unchanged: a storage order, and one value respelled. A case
 * draws one beside its plan perturbation, and both shrink with it.
 */
export interface Restorage {
	/** How far each relation's facts rotate before they are reversed. */
	readonly shift: number
	/** Which stored value of a carrier with twin spellings is stored in its next spelling. */
	readonly respell: number
}

export const restorageGen: Gen<Restorage> = (source) => ({
	shift: source.draw(int(0, 63)),
	respell: source.draw(int(0, 1023))
})

/**
 * The restorage of a case no exploration draws one for, a kept case's among them: each relation's facts rotated once
 * and reversed, and its first twinned value respelled.
 */
export const onceRotated: Restorage = { shift: 1, respell: 0 }

/**
 * The restorage of the case running now, under which a case's second reading stores its facts: provided per explored
 * case beside its perturbation, onceRotated elsewhere.
 */
export const CurrentRestorage = Context.Reference<Restorage>(
	"grizzle/test/oracle/CurrentRestorage",
	{
		defaultValue: () => onceRotated
	}
)

/**
 * The storage order a second reading stores a harness's facts in: another one (the storage-order relation), or the
 * first reading's, where the harness observes what the order decides, so no other order is a relation of its contract.
 */
export type StorageOrder =
	| { readonly kind: "permuted" }
	| {
			readonly kind: "kept"
			/**
			 * What the harness observes that its facts' storage order decides: the tuple each row it reads
			 * is stored at.
			 */
			readonly observed: "tuple ids"
	  }

export const permuted: StorageOrder = { kind: "permuted" }

/** A stored value in its next spelling, an equal value stored otherwise; none for a value of one spelling. */
export type Respelling<V> = (value: V) => Option.Option<V>

/** One relation's stored facts, each row its values in column order, and how each column respells a value. */
export interface StoredRelation<V> {
	readonly name: string
	readonly columns: ReadonlyArray<Respelling<V>>
	readonly rows: ReadonlyArray<ReadonlyArray<V>>
}

/** Every relation's facts stored otherwise, in the order the relations were given, and what the restorage changed. */
export interface Restored<V> {
	readonly relations: ReadonlyArray<StoredRelation<V>>
	readonly reordered: boolean
	readonly respelled: boolean
}

/** The spelling index of a stored value among its type's spellings: 0 its one form, then each twin. */
const spellingIndex = (type: ScalarType, v: SpelledValue): number => {
	switch (v.spelling.kind) {
		case "canonical":
			return 0
		case "twin":
			return twinsOf(type, v.literal).indexOf(v.spelling.text) + 1
	}
}

/** A stored value of `type` in its next spelling among its type's (domain.ts spelledAt), where it has twins. */
export const spelledRespelling =
	(type: ScalarType): Respelling<SpelledValue> =>
	(v) =>
		twinsOf(type, v.literal).length === 0
			? Option.none()
			: Option.some(spelledAt(type, v.literal, spellingIndex(type, v) + 1))

/**
 * A host value of `carrier` stored in its one form, in its first twin spelling (domain.ts carrierTwins) as the loader
 * writes it (install/literal.ts InputSpelling): how a harness whose facts are host values respells one. `literalOf` is
 * the harness's reading of its host value as the IR's literal.
 */
export const inputRespelling =
	(carrier: Carrier, literalOf: (value: unknown) => TypedLiteral): Respelling<unknown> =>
	(v) =>
		Option.map(
			Arr.head(carrierTwins(carrier, literalOf(v))),
			(text): unknown => new InputSpelling(text)
		)

/** A relation's rows in the order `order` stores them: rotated by `shift` and reversed, or as given. */
const orderedRows = <A>(
	rows: ReadonlyArray<A>,
	order: StorageOrder,
	shift: number
): ReadonlyArray<A> => {
	switch (order.kind) {
		case "kept":
			return rows
		case "permuted": {
			const k = rows.length === 0 ? 0 : shift % rows.length
			return Arr.reverse(Arr.appendAll(rows.slice(k), rows.slice(0, k)))
		}
	}
}

/**
 * The facts stored otherwise (the storage-order and twin-spelling invariance relations): each relation's facts in the
 * order `order` stores them, a permutation of the same set (rotated by `shift` and reversed), and the `respell`-th
 * stored value with another spelling stored in its next spelling, an equal value. An answer is a function of the facts,
 * so every side must deliver over the restored facts exactly what it delivers over the facts.
 */
export const restoredFacts = <V>(
	relations: ReadonlyArray<StoredRelation<V>>,
	order: StorageOrder,
	r: Restorage
): Restored<V> => {
	const twinned = Arr.flatMap(relations, (relation) =>
		Arr.flatMap(relation.rows, (row, i) =>
			Arr.flatMap(row, (v, j) =>
				Option.match(elementAt(relation.columns, j, "a fact's column")(v), {
					onNone: () => [],
					onSome: (respelled) => [{ relation: relation.name, row: i, column: j, respelled }]
				})
			)
		)
	)
	const target = twinned.length === 0 ? undefined : twinned[r.respell % twinned.length]
	const moved = Arr.map(relations, (relation): StoredRelation<V> => {
		const rows = Arr.map(relation.rows, (row, i) =>
			target === undefined || target.relation !== relation.name || target.row !== i
				? row
				: Arr.map(row, (v, j) => (j === target.column ? target.respelled : v))
		)
		return { ...relation, rows: orderedRows(rows, order, r.shift) }
	})
	return {
		relations: moved,
		reordered:
			order.kind === "permuted" && Arr.some(relations, (relation) => relation.rows.length > 1),
		respelled: target !== undefined
	}
}
