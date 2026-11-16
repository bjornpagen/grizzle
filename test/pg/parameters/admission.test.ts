/**
 * A write's caller parameters admitted before any of its statements runs, against PostgreSQL 19.
 *
 * Every write's flight begins with its admission (write/admission/statement.ts): one statement binding every caller
 * parameter whose type PostgreSQL checks beyond its base, each cast as its statements cast it, so PostgreSQL refuses a
 * value outside its type as it binds that statement, before the strata run. Without it a parameter is checked only at
 * the Bind of the first statement that reads it, and a statement before that one may fail first, under another law.
 *
 * The box: Admit stores two items. Each of its two writes is two strata (ChangeSet.sequence): the first inserts the
 * items of the relation parameter `fresh`, which collides with a stored item's key or not, so the first stratum fails or
 * not; the second reads a parameter of Code, ^[a-z]{1,4}$, that no statement of the first reads:
 *
 * - `picked` inserts into Pick each stored item with the scalar parameter `p` as its code;
 * - `listed` inserts into Pick the one fact of the relation parameter `named`, the second stored item with its code.
 *
 * Each case draws the write, whether the first stratum collides, and the code, inside Code or outside it. The oracle
 * restates the pattern and the key: a code outside Code is refused at bind as ParamRejected, an `input` CallError naming
 * the parameter (`p`, or `named.code`), whatever the first stratum does, and nothing is written; otherwise a collision
 * is refused by Item's key; otherwise the write is accepted, Pick holding exactly the facts it names.
 *
 * Features: a scalar parameter, and a relation parameter's field, read only by a statement after one that fails; each
 * write refused by the first stratum's key with its code inside Code, and accepted.
 *
 * Two variants a write cannot state, which the admission checks all the same: a parameter read only by a statement the
 * runtime skips (runtime/write/steps.ts skipWhenEmpty), one whose enumerated input holds no fact (write/insert/input.ts
 * skipWhenEmptyOf), which reads that input and no caller parameter; and a refined take bound, since a bound is an
 * integer the checker refuses to type by a contract or a pattern beside it (check/params.ts ParamCell.use).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { boolean, codePoint, element, type Gen, oneOf, string } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { installed } from "#test/pg/reads/support.ts"
import { assert } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { caseHang } from "#test/support/limits.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** A pattern a stored field declares. */
const Code = str.regex("^[a-z]{1,4}$", "u")
const Item = relation("Item", { id: uuid, code: Code }, ["id"])
const Pick = relation("Pick", { item: uuid, code: Code }, ["item"])
const Admit = schema("Admit", [Item, Pick], [])

/** The first stratum of both writes: the items of the relation parameter `fresh`. */
const freshItems = ChangeSet.empty(Admit).insert(
	Item,
	query(Admit).rule((r) => {
		const fresh = r.relation("fresh", { id: Item.fields.id, code: Code })
		const { id, code } = v(fresh, "fresh")
		return r.match(fresh, { id, code }).find({ id, code })
	})
)

/** Each stored item picked with the code `p`. */
const picked = ChangeSet.sequence(
	freshItems,
	ChangeSet.empty(Admit).insert(
		Pick,
		query(Admit).rule((r) => {
			const { id } = v(Item, "item")
			return r.match(Item, { id }).find({ item: id, code: r.param("p", Code) })
		})
	)
)

/** The one fact of the relation parameter `named` picked. */
const listed = ChangeSet.sequence(
	freshItems,
	ChangeSet.empty(Admit).insert(
		Pick,
		query(Admit).rule((r) => {
			const named = r.relation("named", { item: Item.fields.id, code: Code })
			const { item, code } = v(named, "named")
			return r.match(named, { item, code }).find({ item, code })
		})
	)
)

const stored = [
	{ id: "00000000-0000-4000-8000-000000000001", code: "abc" },
	{ id: "00000000-0000-4000-8000-000000000002", code: "de" }
] as const
const freshId = "00000000-0000-4000-8000-000000000003"
/** The first stratum's item that collides with no stored one. */
const freshItem = { id: freshId, code: "xyz" } as const
/** The first stratum's item that collides with the first stored one: its key, another code. */
const collidingItem = { id: "00000000-0000-4000-8000-000000000001", code: "zz" } as const

/** A text inside Code about half the time: lowercase letters, or printable ASCII of any length up to six. */
const textGen: Gen<string> = oneOf([
	string(codePoint(0x61, 0x7a), { min: 1, max: 4 }),
	string(codePoint(0x20, 0x7e), { min: 0, max: 6 })
])

/** Whether a text is one to four ASCII lowercase letters, the language of Code. */
const isCode = (text: string): boolean =>
	text.length >= 1 &&
	text.length <= 4 &&
	Arr.every(
		upTo(text.length, (i) => i),
		(i) => Option.exists(Str.charCodeAt(text, i), (unit) => unit >= 0x61 && unit <= 0x7a)
	)

interface Case {
	readonly write: "picked" | "listed"
	readonly collides: boolean
	readonly code: string
}

const caseGen: Gen<Case> = (source) => ({
	write: source.draw(element(["picked", "listed"] as const)),
	collides: source.draw(boolean),
	code: source.draw(textGen)
})

type Feature =
	| "a scalar parameter read only by a statement after one that fails"
	| "a relation parameter's field read only by a statement after one that fails"
	| `${Case["write"]} refused by the first stratum's key`
	| `${Case["write"]} accepted`

layer(Substrate.layer)(
	"a write's parameters admitted before its statements, against PostgreSQL 19",
	(it) => {
		it.effect(
			"a parameter outside its type is refused as its type refuses it, whatever a statement before its first reader does",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const o = yield* installed(
							Admit,
							{ Item: [...stored] },
							{ label: "admission", programs: { picked, listed } }
						)
						const names = o.installed.installation.names
						const table = (r: string) => printObjectName(names.relation(r))
						const itemId = quoteIdent(names.column("Item", "id"))
						/** The installation as it was installed: Pick empty, Item its two stored items. */
						const reset = Effect.forEach(
							[
								`DELETE FROM ${table("Pick")}`,
								`DELETE FROM ${table("Item")} WHERE ${itemId} = '${freshId}'::uuid`
							],
							(sql) => s.admin.query(sql, []),
							{ discard: true }
						)
						/** Each row Pick holds, its item and its code, in code point order. */
						const written = Effect.map(
							s.admin.queryValues(
								`SELECT ${quoteIdent(names.column("Pick", "item"))}::text, ${quoteIdent(names.column("Pick", "code"))}::text FROM ${table("Pick")}`,
								[]
							),
							(rows) =>
								Arr.sort(
									Arr.map(rows, (row) => Arr.join(Arr.map(row, String), " ")),
									Str.Order
								)
						)
						return yield* Effect.gen(function* () {
							const db = yield* Db.open(o.served.login.roles.app, {})
							return yield* explore(
								{
									suite: "parameters/admission",
									draw: drawn(caseGen),
									literal: Formatter.format,
									oracle: {
										kind: "specification",
										name: "each type restated over the bound value, then Item's key over the first stratum's item, then the items the write names"
									},
									kept: [],
									runs: 40,
									shrink: { kind: "bounded", candidates: 100 },
									concurrency: 1,
									steerEvery: 8,
									coverage: required<Feature>(
										[
											"a scalar parameter read only by a statement after one that fails",
											"a relation parameter's field read only by a statement after one that fails",
											"picked refused by the first stratum's key",
											"picked accepted",
											"listed refused by the first stratum's key",
											"listed accepted"
										],
										{ cases: 40, sense: notesOnly }
									),
									caseHang
								},
								(k, c) =>
									Effect.gen(function* () {
										yield* reset
										const fresh = [k.collides ? collidingItem : freshItem]
										const named = stored[1].id
										const applied = yield* Effect.result(
											answered(
												k.write === "picked"
													? db.workload.picked.once({ params: { fresh, p: k.code }, facts: {} })
													: db.workload.listed.once({
															params: { fresh, named: [{ item: named, code: k.code }] },
															facts: {}
														})
											)
										)
										const param = k.write === "picked" ? "p" : "named.code"
										if (!isCode(k.code)) {
											if (Result.isSuccess(applied)) {
												return assert.fail(
													`a code outside its pattern is refused at bind, not answered ${applied.success.kind}`
												)
											}
											assert.equal(applied.failure.kind, "input", "refused as the call's input")
											assert.ok(
												Str.includes(`parameter ${param} `)(applied.failure.message),
												`the refusal names ${param}: ${applied.failure.message}`
											)
											const unwritten = yield* written
											assert.deepEqual(unwritten, [], "nothing is written")
											if (k.collides) {
												c.note(
													k.write === "picked"
														? "a scalar parameter read only by a statement after one that fails"
														: "a relation parameter's field read only by a statement after one that fails"
												)
											}
											return
										}
										if (Result.isFailure(applied)) {
											return assert.fail(
												`the write answers, not ${Formatter.format(applied.failure)}`
											)
										}
										const answer = applied.success
										if (k.collides) {
											if (answer.kind !== "refused") {
												return assert.fail(
													`a stored item inserted again is refused, not ${answer.kind}`
												)
											}
											assert.deepEqual(
												Arr.map(refusedLaws(answer.refused), (law) => law.kind),
												["primaryKey"],
												"refused by Item's key"
											)
											c.note(`${k.write} refused by the first stratum's key`)
											return
										}
										assert.equal(answer.kind, "accepted", "the write is accepted")
										const rows = yield* written
										assert.deepEqual(
											rows,
											Arr.sort(
												k.write === "picked"
													? Arr.map(
															[...Arr.map(stored, (i) => i.id), freshId],
															(id) => `${id} ${k.code}`
														)
													: [`${named} ${k.code}`],
												Str.Order
											),
											"Pick holds the facts the write names"
										)
										c.note(`${k.write} accepted`)
									})
							)
						}).pipe(Effect.scoped, withLayer(o.served.layer))
					}).pipe(Effect.scoped)
				)
		)
	}
)
