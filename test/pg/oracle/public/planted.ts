import { Array as Arr } from "effect"
import { scalarReader } from "#compiler/codec/read.ts"
import { type Codebook, emptyCodebook, firstCodebook } from "#compiler/ir/codes.ts"
import { rosterOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { SentRow } from "#test/pg/oracle/public/cells.ts"
import { defined } from "#test/support/assert.ts"
import { Identities, type Interned } from "#test/support/kernel/identity.ts"
import type { Nested } from "#test/support/oracle/public/answer.ts"
import type { ParentColumn, Query, Root } from "#test/support/oracle/public/program.ts"
import { valueIdentity } from "#test/support/oracle/reference/values.ts"
import { outputText } from "#test/support/wire.ts"

/**
 * How the suite reads the adapter's delivered rows and their texts, and the planted defects that prove it can fail.
 *
 * The suite reads every public answer as delivered. Its planted-bug check (planted.test.ts) reads the perturbed
 * reader's delivery through `bySpelling` instead, a test double of a stitch by text: the attachment statement keeps one
 * spelling of natively equal parent keys (its DISTINCT), and the host gives the children only to the parents whose key
 * cell PostgreSQL sent in that spelling (cells.ts SentRow), so a parent whose key is equal but stored otherwise gets
 * none. The suite must fail on it, which shows that its population stores two spellings of one parent key with
 * children and that its comparison is exact per parent. A run writes nothing to the tree: the suite's required features hold that reach on every run, and the
 * report prints the shrunk sketch, which a fix promotes into the suite's kept sketches.
 *
 * The suite also reads every cell text its perturbed reader converts strictly (cells.ts), and requires a `Conversion`
 * of the text to agree: the library's own, `asConverted`. Its second planted-bug check passes `boolByF` instead, a
 * trusting boolean conversion that reads only `f` as true: the outermost SELECT writes a boolean as true or false, so
 * every true cell converts to false, and the suite must fail on the first case that delivers one.
 *
 * Its third passes `takeReversed`, a delivery that drops a root take's order: the rows of a query that ends in
 * `.orderBy(...).take(k)` in reverse, never the take's order once two arrive. The suite must fail on it, which shows that
 * its population reaches a root take of two rows or more and that it compares a root take's rows in order.
 *
 * A reading of the perturbed reader's delivered rows, with the rows as PostgreSQL sent them, row for row.
 */
export type Stitch = (
	rows: ReadonlyArray<Nested>,
	query: Root,
	sent: ReadonlyArray<SentRow>
) => ReadonlyArray<Nested>

export const asDelivered: Stitch = (rows) => rows

/** The parent columns a child binds, by position in the parent's heading. */
const keyPositions = (
	q: Query<ParentColumn>,
	child: Query<ParentColumn>
): ReadonlyArray<number> => {
	const names = new Set(
		Arr.flatMap(child.arms[0].matches, (m) =>
			Arr.flatMap(m.bindings, (b) => (b.operand.kind === "parent" ? [b.operand.column.name] : []))
		)
	)
	return Arr.flatMap(q.heading, (c, i) => (names.has(c.name) ? [i] : []))
}

const restitch = (
	q: Query<ParentColumn>,
	rows: ReadonlyArray<Nested>,
	sent: ReadonlyArray<SentRow>
): ReadonlyArray<Nested> => {
	if (rows.length !== sent.length) {
		throw new Error(`${rows.length} delivered rows of ${sent.length} sent`)
	}
	let current = rows
	for (const [a, attachment] of q.attachments.entries()) {
		const positions = keyPositions(q, attachment.child)
		const identities = new Identities()
		const identity = (row: Nested): Interned =>
			identities.of(
				Arr.flatMap(positions, (i) =>
					valueIdentity(
						defined(row.values[i], `the parent value ${i}`),
						defined(q.heading[i], `the column ${i}`).type
					)
				)
			)
		const sentAt = (k: number): SentRow => defined(sent[k], `the sent row ${k}`)
		const spelling = (k: number) =>
			Arr.join(
				Arr.map(positions, (i) =>
					defined(
						sentAt(k).texts.get(defined(q.heading[i], `the column ${i}`).name),
						`the sent cell of column ${i}`
					)
				),
				"\u0000"
			)
		const kept = new Map<
			Interned,
			{
				readonly spelling: string
				readonly children: ReadonlyArray<Nested>
				readonly sent: ReadonlyArray<SentRow>
			}
		>()
		for (const [k, row] of current.entries()) {
			if (!kept.has(identity(row))) {
				kept.set(identity(row), {
					spelling: spelling(k),
					children: defined(row.attachments[a], `the attachment ${a}`),
					sent: defined(sentAt(k).children.get(attachment.name), `the sent ${attachment.name}`)
				})
			}
		}
		current = Arr.map(current, (row, k) => {
			const group = kept.get(identity(row))
			return {
				values: row.values,
				attachments: Arr.map(row.attachments, (list, i) =>
					i !== a
						? list
						: group !== undefined && group.spelling === spelling(k)
							? restitch(attachment.child, group.children, group.sent)
							: []
				)
			}
		})
	}
	return current
}

/** A stitch by text as a test double: children stitched by the spelling their parent's key cell was sent in. */
export const bySpelling: Stitch = (rows, query, sent) => restitch(query, rows, sent)

/** A delivery that drops a root take's order, as a test double: a root take's rows in reverse, every other root's as is. */
export const takeReversed: Stitch = (rows, query) =>
	query.bound.kind === "take" && query.delivery.kind === "set" ? Arr.reverse(rows) : rows

/**
 * The codes a column of `type` is read under in a public-oracle case: every case installs its schema fresh, from no
 * codes (oracle/install/real.ts oraclePlan), so a roster's handles hold the codes of their declared positions, and a
 * type over no roster reads none.
 */
export const freshCodesOf = (type: ScalarType): Codebook => {
	const roster = rosterOf(type)
	return roster === undefined ? emptyCodebook : firstCodebook([roster])
}

/** A trusting conversion of a column type's output text into its host value. */
export type Conversion = (type: ScalarType) => (text: string) => unknown

/** The library's conversion (packages/engine/src/scalar/values/convert.ts). */
export const asConverted: Conversion = (type) => {
	const reader = scalarReader(type, freshCodesOf(type))
	return (text) => reader.convert(outputText(text))
}

/** A boolean conversion that misreads every text but `f`: true where PostgreSQL wrote false, and false for true. */
export const boolByF: Conversion = (type) =>
	type.carrier === "bool" ? (text) => text === "f" : asConverted(type)
