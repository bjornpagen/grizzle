/**
 * A variant field (ir/scalar.ts VariantType) on PostgreSQL 19: one column of the variant's domain over its composite,
 * written and read back through a served Db.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Layer, Option, Order, Result, String as Str } from "effect"
import { Db } from "#adapter/public/db.ts"
import { rowEvaluator } from "#adapter/public/host.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { derivedLaw } from "#compiler/runtime/law-entry.ts"
import { Sha256 } from "#compiler/scalar/values/sha256.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	asSome,
	compareHeld,
	distinctMembers,
	kindCode,
	pickedMarks,
	type SomeHeld,
	someAttributes,
	type Drawn,
	type EmptyFeature,
	type EmptyRead,
	emptyReadGen,
	emptyReads,
	identitySpace,
	flagCode,
	otherZero,
	valueAttributes,
	countsOf,
	type ExactFeature,
	exactGen,
	exactImageOf,
	narrowBound,
	identityOf,
	imageOf,
	partitionOf,
	type ReplyFeature,
	Replies,
	replyFeatures,
	replySpace,
	replyText,
	sizeOf,
	space,
	Variants,
	type VariantFeature,
	variantsInstall,
	variantsTemplate
} from "#test/pg/fields/variant.fixtures.ts"
import { rowsOf, writeAnswerOf } from "#test/support/calls.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A variant's value written through a served Db reads back as the value written, and is read by its arms: an arm's
 * source of each cell is one row of that arm's fields, none for another arm's, and attached as an Option at a cell its
 * relation's key fixes, metis's kept feedback (variant.fixtures.ts feedback), it is that row, the head of its array form.
 */
export const aVariantRoundTrips = property.explore(space, {
	needs: { fixture: Substrate.fresh(variantsTemplate) },
	situations: [
		"the two zeros of a double are two members",
		"a point out of its arm's check refused",
		"a value of no whole arm refused to a direct writer",
		"a name attached as an Option",
		"another arm attached as none"
	] satisfies ReadonlyArray<Reached<VariantFeature>>,
	check:
		({ fixture }, c: Case<VariantFeature>) =>
		(d: Drawn) =>
			Effect.flatMap(fixture, (taken) =>
				Effect.provideService(
					Effect.scoped(
						Effect.gen(function* () {
							const o = yield* openedIn(Variants, {}, variantsInstall, taken)
							yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const cells = Arr.map(d.cells, (value, id) => ({ id, value }))
								const outcome = yield* writeAnswerOf(
									db.workload.cells.once({ params: {}, facts: { insert: { Cell: cells } } })
								)
								assert.equal(outcome.kind, "accepted", "every cell is written")
								const stored = yield* rowsOf(db.workload.allCells.once({ params: {}, facts: {} }))
								assert.deepEqual(
									Arr.map(stored, (row) => [row.id, row.value, row.kind]),
									Arr.map(cells, (c) => [c.id, c.value, c.value.tag]),
									"every cell reads back as written, its generated tag its value's arm"
								)
								const sizes = yield* rowsOf(db.workload.sizes.once({ params: {}, facts: {} }))
								assert.deepEqual(
									Arr.map(sizes, (row) => [row.id, row.size]),
									Arr.map(cells, (c) => [c.id, sizeOf(c.value)]),
									"each cell's cases term is its arm's branch over its arm's fields"
								)
								const probe = defined(cells[0], "a cell").value
								const equal = yield* rowsOf(
									db.workload.equalTo.once({ params: { value: probe }, facts: {} })
								)
								assert.deepEqual(
									Arr.map(equal, (row) => row.id),
									Arr.map(
										Arr.filter(cells, (c) => compareHeld(c.value, probe) === 0),
										(c) => c.id
									),
									"a variant parameter equals exactly the cells the reference model holds equal"
								)
								const made = yield* rowsOf(
									db.workload.made.once({ params: { x: cells.length }, facts: {} })
								)
								assert.deepEqual(
									Arr.map(made, (row) => row.value),
									[{ tag: "point", x: cells.length, y: 70 }],
									"a made value is its arm's handle and the fields it was made of"
								)
								const named = yield* rowsOf(db.workload.named.once({ params: {}, facts: {} }))
								assert.deepEqual(
									Arr.map(named, (row) => [row.id, row.text]),
									Arr.flatMap(cells, (c) => (c.value.tag === "name" ? [[c.id, c.value.text]] : [])),
									"an arm's source is one row of its fields for each cell of that arm, none for another arm's"
								)
								const feedback = yield* rowsOf(db.workload.feedback.once({ params: {}, facts: {} }))
								assert.deepEqual(
									Arr.map(feedback, (row) => [row.id, Option.map(row.text, (t) => t.text)]),
									Arr.map(cells, (c) => [
										c.id,
										c.value.tag === "name" ? Option.some(c.value.text) : Option.none()
									]),
									"a cell's name arm attached as an Option is its one row of that arm, none for another arm's"
								)
								assert.deepEqual(
									Arr.map(feedback, (row) => Option.map(row.text, (t) => t.text)),
									Arr.map(feedback, (row) => Option.map(Arr.head(row.texts), (t) => t.text)),
									"an arm attached as an Option is the head of its array form, metis's kept feedback as it read it"
								)
								for (const row of feedback) {
									c.note(
										Option.isSome(row.text)
											? "a name attached as an Option"
											: "another arm attached as none"
									)
								}
								const outOfOrder = yield* writeAnswerOf(
									db.workload.cells.once({
										params: {},
										facts: {
											insert: { Cell: [{ id: cells.length, value: { tag: "point", x: 2, y: 1 } }] }
										}
									})
								)
								assert.equal(
									outOfOrder.kind,
									"refused",
									"a point whose x passes its y is refused by its arm's check"
								)
								c.note("a point out of its arm's check refused")
								const table = o.installed.names.relation("Cell")
								const owner = yield* Substrate.pipe(
									Effect.flatMap((s) =>
										s.session({ ...ownerSession(), label: "variant direct writer" })
									)
								)
								const variantName = parsedName("Value")
								const composite = printObjectName(o.installed.names.variantRow(variantName))
								const domain = printObjectName(o.installed.names.variantDomain(variantName))
								const flagless = yield* Effect.result(
									owner.query(
										`INSERT INTO ${printObjectName(table)} (${quoteIdent(o.installed.names.column("Cell", "id"))}, ${quoteIdent(o.installed.names.column("Cell", "value"))}) VALUES (${cells.length + 1}, ROW(${flagCode}::int2${Str.repeat(valueAttributes - 1)(", NULL")})::${composite}::${domain})`,
										[]
									)
								)
								assert.ok(
									Result.isFailure(flagless) &&
										flagless.failure.reason._tag === "ServerError" &&
										flagless.failure.reason.fields.code === sqlstates.checkViolation,
									"a value of the flag arm without its field, written by SQL alone, is refused by the variant's domain (23514)"
								)
								c.note("a value of no whole arm refused to a direct writer")
								const members = distinctMembers(d.bag)
								const bagged = yield* writeAnswerOf(
									db.workload.bag.once({
										params: {},
										facts: { insert: { Bag: Arr.map(members, (member) => ({ owner: 1, member })) } }
									})
								)
								assert.equal(bagged.kind, "accepted", "a bag's distinct members are written")
								const bags = yield* rowsOf(db.workload.allBags.once({ params: {}, facts: {} }))
								assert.deepEqual(
									Arr.map(bags, (row) => row.member),
									Arr.sort(members, Order.make(compareHeld)),
									"a bag reads back in its key's order: its tag's code, then its arm's fields"
								)
								const first = defined(members[0], "a member")
								const repeated = yield* writeAnswerOf(
									db.workload.bag.once({
										params: {},
										facts: { insert: { Bag: [{ owner: 1, member: first }] } }
									})
								)
								assert.equal(
									repeated.kind,
									"unchanged",
									"a member the bag holds, written again, meets itself under the key"
								)
								const twin = otherZero(first)
								if (Option.isNone(twin)) {
									return
								}
								const apart = yield* writeAnswerOf(
									db.workload.bag.once({
										params: {},
										facts: {
											insert: {
												Bag: [
													{ owner: 2, member: first },
													{ owner: 2, member: twin.value }
												]
											}
										}
									})
								)
								assert.equal(
									apart.kind,
									"accepted",
									"a double's two zeros are two members: the key's equality is the variant's identity"
								)
								c.note("the two zeros of a double are two members")
							}).pipe(
								(body) =>
									Effect.flatMap(Layer.build(o.served.layer), (context) =>
										Effect.provideContext(body, context)
									),
								Effect.scoped
							)
						})
					),
					Substrate,
					taken.substrate
				)
			),
	oracle: { kind: "second-implementation", name: "the values written" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/physical/ddl/variants.ts",
			original: "\t\t\t\t\t\t\t\t\tpredicate: armCheck(b.names, variant)\n",
			replacement: "\t\t\t\t\t\t\t\t\tpredicate: lit.bool(true)\n",
			why: "The variant's domain holds no arm whole: a direct writer's flag of no field is stored, where the domain's CHECK refuses it (23514)."
		},
		{
			file: "packages/engine/src/scalar/values/identity.ts",
			original: "\tattributes[0] = String(codeOf(spec.roster, value.tag))\n",
			replacement:
				"\tattributes[0] = String(spec.roster.size - 1 - codeOf(spec.roster, value.tag))\n",
			why: "Two arms' codes swapped in the record text a value is written by: a value is written under another arm's tag, which its domain refuses or reads back as another arm."
		},
		{
			file: "packages/engine/src/physical/ddl/variants.ts",
			original: "\t\t\t\t...armCheckOf(names, variant, arm.handle)\n",
			replacement: "",
			why: "An arm check left out of the variant's domain: a point whose x passes its y is stored, where its arm's check refuses it."
		},
		{
			file: "packages/engine/src/lower/conservative/call/index.ts",
			original:
				'\t\t\teq(\n\t\t\t\t{ kind: "attribute", record: value, attribute: variantTagAttribute },\n\t\t\t\tlit.int(arm.code, types.smallint)\n\t\t\t),\n',
			replacement: "\t\t\tlit.bool(true),\n",
			why: "An arm's source keeps every cell, not only its arm's: a cell of another arm delivers a row of absent fields, where the source holds none."
		},
		{
			file: "packages/engine/src/ir/rel.ts",
			original: '\tarm: { kind: "one" }\n}',
			replacement: '\tarm: { kind: "set" }\n}',
			why: "An arm's source is a set of rows at its cell, keyed by its fields alone (ir/rel.ts callNumberings), so the cell its snapshot's key fixes no longer pins its rows and the feedback's Option, metis's kept feedback, is refused at its attachment, as metis met it."
		}
	]
})

/**
 * An empty relation of a variant column answers no row (lower/conservative/closed placeholderValue). A read whose filter
 * has no disjunct and whose head holds a made value is a closed relation of no row to the simplifier, and the lowering
 * stands it on two placeholder rows of its column types under WHERE false; a variant's placeholder is a record of its
 * composite holding its first arm over its fields' placeholders (expr/variant.ts variantRecord), and a side of a delta
 * no statement makes is lowered as that relation is. Before, either was the defect "no closed relation holds a variant"
 * as the installation was compiled: qti-pie's ledger at 3ab19845, whose grade.ts passes noWalkLiterals, the empty
 * relation of two texts, a natural and a QtiValue, as an argument of no rows.
 *
 * The box: one empty read for each first arm the schema's variants hold, its placeholder a boolean's, a bigint's, a
 * closed id's of a subset whose code 0 is outside it, an 825-digit integer's, and a contract's over a double beside its
 * zero sign; the consumer's heading among them; and an insert of a cell that reads back the cells it removed. Oracle: a
 * filter of no disjunct holds of no row, and an insert removes nothing.
 */
export const anEmptyRelationOfAVariantAnswersNoRow = property.exhaust(finite(emptyReadGen), {
	needs: { fixture: Substrate.fresh(variantsTemplate) },
	situations: Arr.map(emptyReads, (e) => e.feature) satisfies ReadonlyArray<Reached<EmptyFeature>>,
	check:
		({ fixture }, c: Case<EmptyFeature>) =>
		(e: EmptyRead) =>
			Effect.flatMap(fixture, (taken) =>
				Effect.provideService(
					Effect.scoped(
						Effect.gen(function* () {
							const o = yield* openedIn(Variants, {}, variantsInstall, taken)
							yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const none = { params: {}, facts: {} }
								const rows: ReadonlyArray<unknown> = yield* (() => {
									switch (e.read) {
										case "noLiterals":
											return rowsOf(db.workload.noLiterals.once(none))
										case "noSomes":
											return rowsOf(db.workload.noSomes.once(none))
										case "noPicks":
											return rowsOf(db.workload.noPicks.once(none))
										case "noWides":
											return rowsOf(db.workload.noWides.once(none))
										case "noReplies":
											return rowsOf(db.workload.noReplies.once(none))
										case "insertedRemoved":
											return Effect.map(
												db.workload.insertedRemoved.once({
													params: {},
													facts: {
														insert: { Cell: [{ id: 0, value: { tag: "flag", value: true } }] }
													}
												}),
												(outcome) => {
													assert.equal(outcome.kind, "accepted", "the cell is written")
													return defined(
														outcome.reads["removed"],
														"the read-back of what it removed"
													)
												}
											)
									}
								})()
								assert.deepEqual(rows, [], `${e.read} answers no row`)
								c.note(e.feature)
							}).pipe(
								(body) =>
									Effect.flatMap(Layer.build(o.served.layer), (context) =>
										Effect.provideContext(body, context)
									),
								Effect.scoped
							)
						})
					),
					Substrate,
					taken.substrate
				)
			),
	oracle: {
		kind: "specification",
		name: "a filter of no disjunct holds of no row, and an insert removes nothing"
	},
	box: "an empty read of each first arm the schema's variants hold (a boolean, a bigint, a closed id of a subset its code 0 is outside, an 825-digit integer, a contract over a double), the consumer's heading of two texts, a natural and a variant among them, and an insert's read-back of what it removed",
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/conservative/closed/index.ts",
			original: '\t\tcase "variant": {\n\t\t\tconst [first] = base.variant.arms\n',
			replacement:
				'\t\tcase "variant": {\n\t\t\tthrow new Error("no closed relation holds a variant")\n\t\t\tconst [first] = base.variant.arms\n',
			why: "A variant holds no placeholder: the installation's compile dies at each empty read, qti-pie's noWalkLiterals among them, and at the insert's read-back of what it removed."
		},
		{
			file: "packages/engine/src/lower/conservative/closed/index.ts",
			original: "\t\tisNonEmpty(rows) ? [] : [lit.bool(false)]\n",
			replacement: "\t\t[]\n",
			why: "An empty relation stands on its placeholder rows unfiltered: each empty read answers its first arm's placeholder, where it answers no row."
		}
	]
})

/**
 * A variant over a subset of its roster holds the arms it names alone (variant.fixtures.ts Some: count, name and none
 * of Kind's seven, listed out of Kind's order): each drawn value of those arms round-trips through a served Db, its tag
 * generated as a closed id of the subset; a JavaScript caller's value of a handle outside the subset, which the types
 * refuse, is refused at the call's input before any SQL; and a direct writer's record of such a handle, every attribute
 * absent as a payload-less arm's is, is refused by the variant's domain (23514), whose CHECK names the subset's codes
 * alone. Beside it, an arm's field of a closed id of a subset (Picked's mark, count or name of Kind) is held to that
 * subset by the variant's domain: a direct writer's mark of the subset is a value of Picked, one outside it 23514, as a
 * stored column of the subset refuses it.
 *
 * The box: the cells of space, Value's values over all seven handles, those of Some's arms written as Some's and the
 * first of another handle written stray. Oracle: the subset as the arms name it.
 */
export const aVariantOverASubsetHoldsItsArmsAlone = property.explore(space, {
	needs: { fixture: Substrate.fresh(variantsTemplate) },
	situations: [
		"a value of the subset's arms round-trips",
		"a handle outside the subset refused",
		"an arm field's handle outside its subset refused"
	] satisfies ReadonlyArray<Reached<VariantFeature>>,
	check:
		({ fixture }, c: Case<VariantFeature>) =>
		(d: Drawn) =>
			Effect.flatMap(fixture, (taken) =>
				Effect.provideService(
					Effect.scoped(
						Effect.gen(function* () {
							const o = yield* openedIn(Variants, {}, variantsInstall, taken)
							yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const somes = Arr.map(Arr.getSomes(Arr.map(d.cells, asSome)), (value, id) => ({
									id,
									value
								}))
								const written = yield* writeAnswerOf(
									db.workload.somes.once({ params: {}, facts: { insert: { Somes: somes } } })
								)
								assert.equal(
									written.kind,
									somes.length > 0 ? "accepted" : "unchanged",
									"every value of the subset's arms is written"
								)
								const stored = yield* rowsOf(db.workload.allSomes.once({ params: {}, facts: {} }))
								assert.deepEqual(
									Arr.map(stored, (row) => [row.id, row.value, row.kind]),
									Arr.map(somes, (s) => [s.id, s.value, s.value.tag]),
									"every value reads back as written, its tag generated as a closed id of the subset"
								)
								if (somes.length > 0) {
									c.note("a value of the subset's arms round-trips")
								}
								const outside = Arr.findFirst(d.cells, (h) => Option.isNone(asSome(h)))
								if (Option.isNone(outside)) {
									return
								}
								const stray = outside.value
								const input = yield* Effect.result(
									writeAnswerOf(
										db.workload.somes.once({
											params: {},
											facts: {
												insert: { Somes: [{ id: somes.length, value: trusted<SomeHeld>(stray) }] }
											}
										})
									)
								)
								assert.ok(
									Result.isFailure(input) && input.failure.kind === "input",
									`a JavaScript caller's ${stray.tag}, a handle no arm of Some names, is refused at the call's input`
								)
								const owner = yield* Substrate.pipe(
									Effect.flatMap((s) =>
										s.session({ ...ownerSession(), label: "variant subset direct writer" })
									)
								)
								const someName = parsedName("Some")
								const composite = printObjectName(o.installed.names.variantRow(someName))
								const domain = printObjectName(o.installed.names.variantDomain(someName))
								const cast = yield* Effect.result(
									owner.query(
										`SELECT ROW(${kindCode(stray.tag)}::int2${Str.repeat(someAttributes - 1)(", NULL")})::${composite}::${domain}`,
										[]
									)
								)
								assert.ok(
									Result.isFailure(cast) &&
										cast.failure.reason._tag === "ServerError" &&
										cast.failure.reason.fields.code === sqlstates.checkViolation,
									`a direct writer's ${stray.tag}, every attribute absent, is refused by Some's domain (23514)`
								)
								c.note("a handle outside the subset refused")
								const pickedName = parsedName("Picked")
								const picked = (mark: (typeof pickedMarks)[keyof typeof pickedMarks]) =>
									Effect.result(
										owner.query(
											`SELECT ROW(${flagCode}::int2, ${kindCode(mark)}::int2)::${printObjectName(o.installed.names.variantRow(pickedName))}::${printObjectName(o.installed.names.variantDomain(pickedName))}`,
											[]
										)
									)
								const heldMark = yield* picked(pickedMarks.held)
								assert.ok(
									Result.isSuccess(heldMark),
									"a direct writer's mark of the arm field's subset is a value of Picked"
								)
								const outsideMark = yield* picked(pickedMarks.outside)
								assert.ok(
									Result.isFailure(outsideMark) &&
										outsideMark.failure.reason._tag === "ServerError" &&
										outsideMark.failure.reason.fields.code === sqlstates.checkViolation,
									"a direct writer's mark outside the arm field's subset is refused by Picked's domain (23514), as a stored column of the subset refuses it"
								)
								c.note("an arm field's handle outside its subset refused")
							}).pipe(
								(body) =>
									Effect.flatMap(Layer.build(o.served.layer), (context) =>
										Effect.provideContext(body, context)
									),
								Effect.scoped
							)
						})
					),
					Substrate,
					taken.substrate
				)
			),
	oracle: { kind: "specification", name: "the subset as the arms name it" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/physical/ddl/variants.ts",
			original: "\t\telse: lit.bool(false)\n",
			replacement: "\t\telse: lit.bool(true)\n",
			why: "The variant's domain admits a tag no arm names: a direct writer's record of a handle outside the subset, every attribute absent, is a value of Some."
		},
		{
			file: "packages/engine/src/scalar/registry.ts",
			original: "\t\tonly: variantOnly(variant)\n",
			replacement: "\t\tonly: undefined\n",
			why: "Some's tag typed as a closed id of every handle of Kind: it enters no column of the subset, so Somes's generated tag is refused and the schema compiles no installation."
		},
		{
			file: "packages/engine/src/physical/ddl/variants.ts",
			original:
				"\t\t\t\t\t\t: [subsetPredicate(names.codes, valueAttribute(f.attribute), f.field.type)]\n",
			replacement: "\t\t\t\t\t\t: []\n",
			why: "The variant's domain holds an arm's field of a subset to its roster alone: a direct writer's mark outside the subset is a value of Picked, and a term reading it is typed by a subset it lies outside."
		}
	]
})

/**
 * A variant's one equality is its identity, the equality its digest keys (scalar/variant-digest.ts): -0 apart from 0,
 * every NaN one, a text by its bytes. GROUP BY, a self-join and the digest partition a case's cells alike, as the
 * reference model's identity does, and each image is the reference model's; a ratio made of a parameter and of its
 * negation have one image exactly where the parameter is NaN.
 */
export const aVariantsEqualityIsItsIdentity = property.explore(identitySpace, {
	needs: { fixture: Substrate.fresh(variantsTemplate) },
	situations: [
		"two cells of the two zeros grouped apart",
		"two cells of NaN grouped as one",
		"a NaN and its negation one image",
		"a zero and its negation two images"
	] satisfies ReadonlyArray<Reached<VariantFeature>>,
	check:
		({ fixture }, c: Case<VariantFeature>) =>
		(d: Drawn) =>
			Effect.flatMap(fixture, (taken) =>
				Effect.provideService(
					Effect.scoped(
						Effect.gen(function* () {
							const o = yield* openedIn(Variants, {}, variantsInstall, taken)
							yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const cells = Arr.map(d.cells, (value, id) => ({ id, value }))
								yield* writeAnswerOf(
									db.workload.cells.once({ params: {}, facts: { insert: { Cell: cells } } })
								)
								const partition = partitionOf(d.cells)
								const groups = yield* rowsOf(db.workload.groups.once({ params: {}, facts: {} }))
								assert.deepEqual(
									Arr.sort(
										Arr.map(groups, (row) => `${identityOf(row.value)} ${row.n}`),
										Order.String
									),
									Arr.sort(
										Arr.map(Arr.fromIterable(partition), ([key, n]) => `${key} ${n}`),
										Order.String
									),
									"GROUP BY a variant groups its cells by their identity"
								)
								const images = yield* rowsOf(db.workload.images.once({ params: {}, facts: {} }))
								assert.deepEqual(
									Arr.map(images, (row) => [row.id, Sha256.toHex(row.image)]),
									Arr.map(cells, (cell) => [cell.id, imageOf(cell.value)]),
									"each cell's image is the reference model's"
								)
								const imaged = yield* writeAnswerOf(
									db.workload.imaged.once({
										params: {},
										facts: {
											insert: {
												Imaged: Arr.map(cells, (cell) => ({ owner: cell.id, value: cell.value }))
											}
										}
									})
								)
								assert.equal(
									imaged.kind,
									cells.length > 0 ? "accepted" : "unchanged",
									"each cell's value is written by its facts under its image, a key generation"
								)
								const stored = yield* rowsOf(db.workload.allImaged.once({ params: {}, facts: {} }))
								assert.deepEqual(
									Arr.map(stored, (row) => [row.owner, Sha256.toHex(row.image)]),
									Arr.map(images, (row) => [row.id, Sha256.toHex(row.image)]),
									"each value written by facts is keyed by the image the write fills on the host, PostgreSQL's own"
								)
								const byImage = new Map<string, number>()
								for (const row of images) {
									const hex = Sha256.toHex(row.image)
									byImage.set(hex, (byImage.get(hex) ?? 0) + 1)
								}
								assert.deepEqual(
									countsOf(byImage),
									countsOf(partition),
									"the images partition the cells as their identity does"
								)
								const pairs = yield* rowsOf(db.workload.pairs.once({ params: {}, facts: {} }))
								assert.equal(
									pairs.length,
									Arr.reduce(Arr.fromIterable(partition.values()), 0, (n, k) => n + k * k),
									"a join on the variant pairs exactly the cells of one identity"
								)
								const ratios = Arr.filter(d.cells, (h) => h.tag === "ratio")
								if (
									Arr.some(ratios, (h) => Object.is(h.value, 0)) &&
									Arr.some(ratios, (h) => Object.is(h.value, -0))
								) {
									c.note("two cells of the two zeros grouped apart")
								}
								if (Arr.filter(ratios, (h) => Number.isNaN(h.value)).length > 1) {
									c.note("two cells of NaN grouped as one")
								}
								const [negation] = yield* rowsOf(
									db.workload.negations.once({ params: { x: d.ratio }, facts: {} })
								)
								const one = Sha256.equals(
									defined(negation, "one row").plain,
									defined(negation, "one row").negated
								)
								assert.equal(
									one,
									Number.isNaN(d.ratio),
									"a ratio and its negation are one image exactly where the ratio is NaN"
								)
								if (Number.isNaN(d.ratio)) {
									c.note("a NaN and its negation one image")
								}
								if (d.ratio === 0) {
									c.note("a zero and its negation two images")
								}
							}).pipe(
								(body) =>
									Effect.flatMap(Layer.build(o.served.layer), (context) =>
										Effect.provideContext(body, context)
									),
								Effect.scoped
							)
						})
					),
					Substrate,
					taken.substrate
				)
			),
	oracle: {
		kind: "second-implementation",
		name: "the reference model's identity and image of each value"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/write/frontend/compile.ts",
			original: "\t\t\t\t\t\t\t\t\t\tgenerations: keyGenerations(relation.fields)\n",
			replacement: "\t\t\t\t\t\t\t\t\t\tgenerations: []\n",
			why: "A facts insert fills no key generation its host checks no key over: Imaged's image, under a key over the instant its insert stamps, is sent unfilled and the write dies a defect, where the program path's image is stored (edullm's Q14, the ledger's SnapshotMultiple)."
		},
		{
			file: "packages/engine/src/ir/codes.ts",
			original: "\t\t\t\tconst zero = float(field) ? value + 1 : undefined\n",
			replacement: "\t\t\t\tconst zero = undefined\n",
			why: "A float field is its value alone in the composite, so record equality decides a variant's equality: GROUP BY and the join hold -0 and 0 one, where the variant's identity and its digest hold them apart."
		},
		{
			file: "packages/engine/src/lower/conservative/expr/variant.ts",
			original: '\t\t\treturn call("int8send", [floatImage(x, floatOf(type))])\n',
			replacement: '\t\t\treturn call("float8send", [x])\n',
			why: "A float's image is its raw bits, every NaN no longer one: a NaN and its negation, whose sign bit differs, take two images."
		},
		{
			file: "packages/engine/src/lower/conservative/expr/variant.ts",
			original: '\t\t\treturn call("int8send", [floatImage(x, floatOf(type))])\n',
			replacement:
				'\t\t\treturn call("int8send", [floatImage(binary("+", x, lit.float(0, types.double)), floatOf(type))])\n',
			why: "A float's image is taken of the float plus 0, which IEEE 754 makes 0 of -0: a zero and its negation take one image, -0 no longer apart from 0."
		}
	]
})

/**
 * An exact integer's image (scalar/variant-digest.ts) is its value's: PostgreSQL's digest of a value of an arm of
 * numeric(825, 0) is the reference model's, the SHA-256 of the arm's handle's digest and of the integer's decimal text,
 * over integers of either sign, 0, near 2^63 and 2^64 and of 825 digits; and an integer numeric(30, 0) holds too takes
 * one image under either precision.
 */
export const anExactIntegersImageIsItsValue = property.explore(exactGen, {
	needs: { fixture: Substrate.fresh(variantsTemplate) },
	situations: [
		"a negative integer",
		"an integer past 2^63",
		"an integer of 825 digits",
		"one integer at two precisions"
	] satisfies ReadonlyArray<Reached<ExactFeature>>,
	check:
		({ fixture }, c: Case<ExactFeature>) =>
		(x: bigint) =>
			Effect.flatMap(fixture, (taken) =>
				Effect.provideService(
					Effect.scoped(
						Effect.gen(function* () {
							const o = yield* openedIn(Variants, {}, variantsInstall, taken)
							yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const [wide] = yield* rowsOf(
									db.workload.wideImage.once({ params: { x }, facts: {} })
								)
								assert.equal(
									Sha256.toHex(defined(wide, "one row").image),
									exactImageOf(x),
									"an exact integer's image is the digest of its decimal text after its arm's"
								)
								if (x < 0n) {
									c.note("a negative integer")
								}
								if (x >= 2n ** 63n || x < -(2n ** 63n)) {
									c.note("an integer past 2^63")
								}
								if (Str.replace("-", "")(x.toString()).length === 825) {
									c.note("an integer of 825 digits")
								}
								if (x < narrowBound && x > -narrowBound) {
									const [narrow] = yield* rowsOf(
										db.workload.narrowImage.once({ params: { x }, facts: {} })
									)
									assert.ok(
										Sha256.equals(defined(narrow, "one row").image, defined(wide, "one row").image),
										"one integer takes one image under numeric(30, 0) and numeric(825, 0)"
									)
									c.note("one integer at two precisions")
								}
							}).pipe(
								(body) =>
									Effect.flatMap(Layer.build(o.served.layer), (context) =>
										Effect.provideContext(body, context)
									),
								Effect.scoped
							)
						})
					),
					Substrate,
					taken.substrate
				)
			),
	oracle: {
		kind: "second-implementation",
		name: "the reference model's image of an exact integer"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/conservative/expr/variant.ts",
			original: '\t\t\treturn qualifiedCall(names.library("textDigest"), [cast(x, types.text)])\n',
			replacement:
				'\t\t\treturn qualifiedCall(names.library("textDigest"), [cast(call("abs", [x]), types.text)])\n',
			why: "An exact integer's image drops its sign: a negative integer takes its magnitude's image, which the host's reference holds apart."
		},
		{
			file: "packages/engine/src/lower/conservative/expr/variant.ts",
			original: '\t\t\treturn qualifiedCall(names.library("textDigest"), [cast(x, types.text)])\n',
			replacement:
				'\t\t\treturn qualifiedCall(names.library("textDigest"), [binary("||", cast(x, types.text), lit.text(".00", types.text))])\n',
			why: "An exact integer's image pads its digits with a scale's zeros, 5 imaged as 5.00: PostgreSQL's image is no longer the host's, of its decimal text."
		}
	]
})

/** The host's admission of a row, every case's, its schema compiled once. */
const evaluator = Result.getOrThrow(rowEvaluator(Variants))

/**
 * A variant's domain is one judgment on the host and in PostgreSQL: the host's admission of a row (rowEvaluator's admit,
 * program/evaluate.ts admission) holds a value to its tagged arm's fields' types, a contract's and a pattern's, and to
 * the arm's check, read off the one VariantInfo the domain's CHECK is printed from (scalar/compute/evaluate.ts
 * variantMembership), so it admits a reply exactly where the database stores it, and refuses one, DomainRefused at
 * its field, exactly where the database refuses it, 23514. A served write the database refuses is refused at the
 * field too: its outcome names the field's one variant law, every one the host judges the row breaks, its witness the
 * row's key, whichever domain PostgreSQL reported, the variant's own (physical/install/plan.ts
 * variantDomainConstraintLaws) or the contract's or pattern's domain of an arm's field the variant's CHECK casts it to,
 * each of which counts the variant's column among its uses, judged on the host by the same membership
 * (runtime/write/witness.ts levelStates).
 *
 * The box: a reply of each arm, each field at its domain's boundaries: a score below zero, each zero, NaN, ±∞ and the
 * largest double; a span equal, out of order and at the integer type's extremes; a word at and past its pattern's
 * lengths, empty, with a capital or a digit; a tally below zero and at its greatest. Oracle: PostgreSQL, the domain's
 * CHECK the reply is written under.
 */
export const aVariantsHostAdmissionIsItsDomain = property.explore(replySpace, {
	needs: { fixture: Substrate.fresh(variantsTemplate) },
	situations: [
		"a score below zero",
		"a zero score of each sign",
		"a NaN score",
		"an infinite score",
		"a span at its bound",
		"a span out of order",
		"a word outside its pattern",
		"a tally below zero",
		"silence"
	] satisfies ReadonlyArray<Reached<ReplyFeature>>,
	check:
		({ fixture }, c: Case<ReplyFeature>) =>
		(reply) =>
			Effect.flatMap(fixture, (taken) =>
				Effect.provideService(
					Effect.scoped(
						Effect.gen(function* () {
							const o = yield* openedIn(Variants, {}, variantsInstall, taken)
							yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const host = evaluator.admit(Replies, { id: 1, reply })
								const written = yield* writeAnswerOf(
									db.workload.replies.once({
										params: {},
										facts: { insert: { Replies: [{ id: 1, reply }] } }
									})
								)
								assert.equal(
									written.kind,
									Result.isSuccess(host) ? "accepted" : "refused",
									`the host ${Result.isSuccess(host) ? "admits" : "refuses"} ${replyText(reply)}, as the database does`
								)
								if (Result.isFailure(host)) {
									assert.deepEqual(
										[host.failure._tag, host.failure.field],
										["DomainRefused", "reply"],
										"the host refuses a reply outside its domain at its field"
									)
									const at = `the database refuses ${replyText(reply)} at its field, naming its variant law`
									if (written.kind !== "refused") {
										return assert.fail(`${at}, not ${written.kind}`)
									}
									assert.equal(written.refused.kind, "every", at)
									assert.deepEqual(
										refusedLaws(written.refused),
										[
											derivedLaw({
												kind: "variant",
												relation: "Replies",
												field: "reply",
												variant: "Reply"
											})
										],
										at
									)
									assert.deepEqual(
										written.witness,
										{ kind: "key", relation: "Replies", values: { id: 1 } },
										at
									)
								}
								for (const feature of replyFeatures(reply)) {
									c.note(feature)
								}
							}).pipe(
								(body) =>
									Effect.flatMap(Layer.build(o.served.layer), (context) =>
										Effect.provideContext(body, context)
									),
								Effect.scoped
							)
						})
					),
					Substrate,
					taken.substrate
				)
			),
	oracle: { kind: "second-implementation", name: "PostgreSQL, the variant's domain's CHECK" },
	kept: [
		{
			token: ReplayToken("test/pg/fields/variant.test.ts#aVariantsHostAdmissionIsItsDomain:-:1"),
			reason:
				"a span out of its arm's check, span(1, 0), which the variant's own domain refuses: a served write of it came back failed, no law naming the variant's domain, where it is refused at its field by the field's variant law",
			since: "2026-11-25"
		},
		{
			token: ReplayToken("test/pg/fields/variant.test.ts#aVariantsHostAdmissionIsItsDomain:-:2"),
			reason:
				"a reply scored -1, which ReplyScore's domain refuses as the variant's domain's CHECK casts the score to it: refused at its field by the field's variant law, never by ReplyScore's contract law, which no stored column of ReplyScore states",
			since: "2026-11-25"
		}
	],
	kills: [
		{
			file: "packages/engine/src/physical/install/plan.ts",
			original: "\t\t\t...variantDomainConstraintLaws(variants),\n",
			replacement: "",
			why: "The variant's domain discharges no law: a served write of a span out of its arm's check comes back failed, as before the variant law, where it is refused at its field."
		},
		{
			file: "packages/engine/src/physical/install/plan.ts",
			original:
				"\t\t\t\tarmTyped(v, (t) => contractChain(t).some(checks)) ? [variantUse(v)] : []\n",
			replacement: "\t\t\t\t[]\n",
			why: "A contract's domain counts no variant column among its uses: a reply scored -1 is refused by ReplyScore's contract law, no field's, where it is refused at its field."
		},
		{
			file: "packages/engine/src/physical/install/plan.ts",
			original: "\t\t\t\tarmTyped(v, (t) => structuralRegex(t)?.key === key) &&\n",
			replacement: "\t\t\t\tfalse &&\n",
			why: "A text domain counts no variant column among its uses: Word's domain, which no stored field types, discharges no law, so a served write of a word outside its pattern comes back failed."
		},
		{
			file: "packages/engine/src/scalar/regex/patterns.ts",
			original: "\t\t\t...arm.fields.flatMap((f) => typePatterns(f.type)),\n",
			replacement: "",
			why: "A served write's witness holds no matcher of a pattern an arm's field is checked against: judging a refused word outside its pattern, it dies a defect where it names the field's variant law."
		},
		{
			file: "packages/engine/src/runtime/write/witness.ts",
			original:
				'\t\tcase "pattern":\n\t\tcase "variant":\n\t\t\treturn level.contract === undefined\n',
			replacement:
				'\t\tcase "pattern":\n\t\t\treturn level.contract === undefined\n\t\tcase "variant":\n\t\t\treturn false\n',
			why: "The witness judges no variant column, so it never runs the variant's membership over the stated row: a refused reply's witness is unreported, not the row's key."
		},
		{
			file: "packages/engine/src/scalar/compute/evaluate.ts",
			original:
				"\t\tconst member = membership(evaluatedValue(field.type, value[field.name]), field.type, patterns)\n",
			replacement: "\t\tconst member: Result.Result<boolean, EvalStop> = Result.ok(true)\n",
			why: "The host skips the arm's fields' contracts and patterns: a reply scored -1, NaN or ∞, or a word outside its pattern, is admitted where the database refuses it."
		},
		{
			file: "packages/engine/src/scalar/compute/evaluate.ts",
			original: "\treturn predicateHolds(arm.check, value, patterns)\n",
			replacement: "\treturn Result.ok(true)\n",
			why: "The host skips the arm's check: a span whose least passes its greatest is admitted where the database refuses it."
		},
		{
			file: "packages/engine/src/ir/scalar.ts",
			original:
				'export const isJudged = (t: ScalarType): boolean => isRefined(t) || baseOf(t).carrier === "variant"\n',
			replacement: "export const isJudged = (t: ScalarType): boolean => isRefined(t)\n",
			why: "The host's admission judges no variant field: every reply its codec reads is admitted, those the domain's CHECK refuses among them."
		}
	]
})
