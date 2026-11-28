/**
 * Where a derived relation's rows live is the installation's inference, never its author's declaration
 * (analysis/derived/storage.ts): stored, in a table grizzle keeps equal to its definition at every COMMIT, exactly where
 * its definition is unit-local within one declared unit, every declared function it calls immutable throughout, at the
 * widest unit its head delivers, that unit wider than the declared one, so its upkeep re-derives the keys a write
 * touched alone, and some read of it, its root, binding with the unit a key of every other read, so that re-derivation
 * reads the root's rows and one row of each other relation for each, or its key holding a key of every relation it
 * reads, so its upkeep reads one row of each at a key (or
 * the declared unit sealed at founding, which no unit of the box is), or else its delta form checked, each fact a write
 * withdraws read at the fact or from its table past its unit, or monotone over closed relations, a write that removes
 * no row only gaining facts (analysis/theory/upkeep.ts deltaBoundOf), and its table can hold its rows;
 * live otherwise, by the first condition of unit-locality it lacks, for its upkeep, which would re-derive the whole
 * declared unit at every write, or for its table. Whether the relations it reads are closed decides only a monotone
 * form: an open relation inside its unit is kept under the borrow its writers hold. A read of a stored relation reads its table, a write of one
 * of the relations its definition reads reads its definition, whose table the write's own COMMIT replaces
 * (analysis/schema.ts CheckedSchema serves, ir/derived.ts servedQuery), and a read of a live one reads the relations
 * its definition reads.
 *
 * The box is every definition of storage.fixtures.ts over a document's places, links and notes: a projection, the same
 * under other names, one that drops the place, one that reads each document's place at its own number, Doc's whole key
 * bound to the document's variable through that equality (den's Requested), one that hides its unit, counts by document and across documents, a join
 * across documents, a negation within one and across, a call of an immutable function, of a stable one and of an
 * immutable one whose body calls a stable one, a cast value no table holds (edullm's NamedDeclaration), a count in an
 * interior stage of the rule that reads it (ledger's ItemDuration), a union whose arm heads a bare literal its position
 * types (edullm's assembledPartRows), one whose one key holds a text of no byte bound, a closed relation alone,
 * frozen at the installation (ir/unit.ts FrozenUnit), a place's mark beside the place's value, rooted at the mark, and
 * each place's value beside its mark 0, Mark's whole key held by the place and a literal a conjunct of its condition
 * equates the number to, each place no mark of it
 * stands at, a probe of Mark at the place, a union of each place's marks of one value and of another, each arm rooted
 * alone (metis's AssignmentStatus), and each mark with its place's
 * least later mark, its marks read at the place and a range for each, no key of either bound
 * by the other (ledger's presentedSpans, stored at its sitting under the unit of the learner at 180 to 244 pages a call
 * before it needed a root); every relation closed under no unit declared, a unit of the
 * document, or one of the document and its place, which every relation sits in alike; or Doc open under either unit;
 * and v a key of Doc or not. Where it is, the head that hides the unit and the one that delivers the document and hides
 * the place each determine the unit through Doc's key on v, every fact at one head of one unit, so each is stored with
 * the fields it hides beside its head, as metis's DashboardEntry, its head a sitting's number, each number a learner's
 * by Assignment's key on it (analysis/theory/unit.ts HiddenUnit).
 *
 * The oracle is the rule restated as a model (a specification): stored at the unit its head delivers or hides and
 * determines, in the declared unit its relations sit in, its upkeep bounded by its unit or by its delta form, or live by
 * the condition it lacks, its unit-locality before its borrow before its upkeep before its table.
 *
 * Features: each shape's holding, each live holding for a borrow or an upkeep, each holding its delta form bounds, and a
 * relation stored over an open one.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { succeeded } from "#test/support/assert.ts"
import { compiledOf } from "#test/support/unit/analysis/theory/rule-query.fixtures.ts"
import {
	derivedName,
	holdingOf,
	holdingStated,
	readsOf,
	type Shape,
	storageCase,
	holderOf,
	storageSchemaOf,
	decidingDelta
} from "#test/support/unit/derived/storage.fixtures.ts"

type StorageFeature =
	| `${"stored" | "live"} ${Shape}`
	| "live for its borrow, no unit declared"
	| "live for its borrow, a unit wider than its own"
	| "live for its upkeep, a fold or a query of several rules"
	| "stored by its checked delta form"
	| "stored as monotone over closed relations"
	| "live for its recursion, under no founded unit"
	| "live for its copy of Doc's rows"
	| "stored over an open relation"

/**
 * A derived relation is stored exactly where its definition is unit-local within one declared unit and its table holds
 * its rows, and live by the condition it lacks otherwise; a read of a stored one reads its table, a write of a relation
 * it reads its definition, and a read of a live one the relations its definition reads.
 */
export const aDerivedRelationIsStoredExactlyWhereItsDefinitionIsUnitLocalWithinOneUnitAndLiveByTheConditionItLacks =
	property.exhaust(finite(storageCase), {
		needs: {},
		situations: [
			"live projection",
			"stored renamed",
			"live by document",
			"stored self-placed",
			"live hidden",
			"stored hidden",
			"live counted by document",
			"live counted across documents",
			"live joined across documents",
			"stored negated within",
			"live negated across",
			"stored immutable call",
			"live stable call",
			"live call of a stable call",
			"stored cast value",
			"live interior count",
			"stored literal arm",
			"live unrepresentable",
			"stored closed alone",
			"stored marked place",
			"live next mark",
			"stored next mark",
			"stored next number's mark",
			"stored marked before another",
			"stored latest mark beside each",
			"stored mark pairs",
			"stored by document",
			"live reachable places",
			"stored first mark",
			"stored unmarked place",
			"stored marks of either value",
			"live for its borrow, no unit declared",
			"live for its borrow, a unit wider than its own",
			"live for its upkeep, a fold or a query of several rules",
			"stored by its checked delta form",
			"stored as monotone over closed relations",
			"live for its recursion, under no founded unit",
			"live for its copy of Doc's rows",
			"stored over an open relation"
		] satisfies ReadonlyArray<Reached<StorageFeature>>,
		check: (_, c: Case<StorageFeature>) => (stored) =>
			Effect.sync(() => {
				const { top, read } = storageSchemaOf(stored)
				const artifacts = succeeded(compiledOf(top), "every schema of the box compiles")
				const expected = holdingOf(stored)
				assert.deepEqual(holdingStated(artifacts), expected, Formatter.format(stored))
				const read_ = readsOf(artifacts, read, new Set())
				const written = readsOf(artifacts, read, new Set([holderOf(stored.shape)]))
				const elsewhere = readsOf(artifacts, read, new Set(["Note"]))
				switch (expected.kind) {
					case "stored":
						assert.deepEqual(
							[...read_],
							[derivedName],
							"a read of a stored relation reads its table alone"
						)
						assert.ok(
							!written.has(derivedName),
							"a write of a relation its definition reads reads its definition, never its table"
						)
						assert.deepEqual(
							[...elsewhere],
							[derivedName],
							"a write of no relation its definition reads reads its table"
						)
						break
					case "frozen":
						for (const reads of [read_, written, elsewhere]) {
							assert.deepEqual(
								[...reads],
								[derivedName],
								"a read of a relation frozen at the installation reads its table alone, whatever a write writes"
							)
						}
						break
					case "live":
						assert.ok(
							!read_.has(derivedName),
							"a read of a live relation reads the relations its definition reads"
						)
						break
				}
				if (expected.kind === "live" && expected.lacks === "borrow") {
					c.note(
						stored.declared === "none"
							? "live for its borrow, no unit declared"
							: "live for its borrow, a unit wider than its own"
					)
					return
				}
				if (expected.kind === "live" && expected.lacks === "recursion") {
					c.note("live for its recursion, under no founded unit")
				}
				if (expected.kind === "live" && expected.lacks === "copy") {
					c.note("live for its copy of Doc's rows")
				}
				if (expected.kind === "live" && expected.lacks === "unboundedUpkeep") {
					c.note("live for its upkeep, a fold or a query of several rules")
				}
				if (expected.kind === "stored" && expected.bound === "delta") {
					c.note(
						decidingDelta(stored) === "checked"
							? "stored by its checked delta form"
							: "stored as monotone over closed relations"
					)
				}
				if (expected.kind === "stored" && stored.mutability === "Doc open") {
					c.note("stored over an open relation")
				}
				c.note(`${expected.kind === "live" ? "live" : "stored"} ${stored.shape}`)
			}),
		oracle: {
			kind: "specification",
			name: "analysis/derived/storage.ts: a derived relation whose rows are one relation's own, projected onto a key of it with no condition, is live as a copy; any other is stored at the widest unit its head delivers, or hides and determines through a key of a relation it matches, where its definition is unit-local within one declared unit narrower than that unit, calls only immutable functions and its table holds its rows, else live by the first condition it lacks; a read of a stored one reads its table, a write of a relation it reads its definition"
		},
		box: "every shape of twenty-nine, every relation closed under no unit declared, a unit of the document or one of the document and its place, or Doc open inside either, v a key of Doc or not",
		kept: [
			{
				token: ReplayToken(
					"test/unit/derived/storage.test.ts#aDerivedRelationIsStoredExactlyWhereItsDefinitionIsUnitLocalWithinOneUnitAndLiveByTheConditionItLacks:-:0.0.0.1"
				),
				reason:
					"Every place, Doc's own rows projected onto its key, closed under the unit of the document: edullm's ledger canonical e2506d21e151aaaa, item_session's key, a copy of item_session stored at qti-pie's car and kept at every take, 74 pages of upkeep a write that no reader gained from, live",
				since: "2026-11-26"
			},
			{
				token: ReplayToken(
					"test/unit/derived/storage.test.ts#aDerivedRelationIsStoredExactlyWhereItsDefinitionIsUnitLocalWithinOneUnitAndLiveByTheConditionItLacks:-:d.0.0.1"
				),
				reason:
					"A cast value no table of the base holds, closed under the unit of the document: edullm's NamedDeclaration, a declaration's identifier cast from its attribute's text, stored, so the judge of PlacedVariableRefDeclaration's reference rule reads its table by key, where it filtered every identifier attribute of a document per key, 368M rows for 7,774 keys on the giant publish",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/unit/derived/storage.test.ts#aDerivedRelationIsStoredExactlyWhereItsDefinitionIsUnitLocalWithinOneUnitAndLiveByTheConditionItLacks:-:4.1.0.1"
				),
				reason:
					"A head that hides the document and the place, v a key of Doc, closed under the unit of the document: metis's DashboardEntry, keyed by tab and a sitting's number, each number a learner's by Assignment's key on it, stored with the learner beside its head, where it was live and computed whole at every call of the coach's dashboard",
				since: "2026-11-25"
			},
			{
				token: ReplayToken(
					"test/unit/derived/storage.test.ts#aDerivedRelationIsStoredExactlyWhereItsDefinitionIsUnitLocalWithinOneUnitAndLiveByTheConditionItLacks:-:3.0.0.1"
				),
				reason:
					"Each document's value at the place its own number names, closed under the unit of the document: den's Requested, a root's own scope admitted and not skipped, each relation read at its whole key through the equality scope = root, stored at the root, where its upkeep was judged unbounded and it was live, re-derived at every worker's read",
				since: "2026-11-25"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: "\tconst copied = copiedRelation(input.definition, input.known)\n",
				replacement: "\tconst copied = undefined\n",
				why: "A copy of one relation's rows stored: edullm's ledger canonical e2506d21e151aaaa, item_session's key, kept at every take, 74 pages of upkeep a write, for no reader who reads it more cheaply than item_session's key index."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original:
					"\t\t[r.primaryKey, ...r.keys].some((key) => key.every((f) => delivered.has(f)))\n",
				replacement: "\t\ttrue\n",
				why: "A projection onto no key read as a copy: each document's values, fewer rows than Doc's, live, where its table holds each value once and its upkeep re-derives the document a write touched."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: '\t\tr.kind !== "closed" &&\n',
				replacement: "",
				why: "A closed relation's rows read as a copy: the closed relation's handles live, read from the VALUES list every statement prints, where the table frozen at the installation is read by key."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: "\t\trule.where.length > 0 ||\n",
				replacement: "",
				why: "A selection read as a copy: each place no link leaves, fewer rows than Doc's, live, where its table holds them."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: '\t\tif (e.kind !== "var" || fieldOf.has(e.var)) {\n',
				replacement: '\t\tif (e.kind !== "var") {\n',
				why: "A match binding one variable at two fields read as a copy: each document's value at the place its own number names, an equality of two of Doc's fields, live where v is a key, though it holds only the rows the equality keeps (den's Requested)."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original:
					'\tconst analyzed = analyze()\n\tif (!analyzed.ok) {\n\t\treturn live({ kind: "unrepresentable", refusal: analyzed.error })\n\t}\n',
				replacement:
					'\tconst analyzed = analyze()\n\tif (analyzed.ok || !analyzed.ok) {\n\t\treturn live({ kind: "notUnitLocal", lacks: { condition: "noUnit", detail: "" } })\n\t}\n',
				why: "The inference disabled: every derived relation live, so no definition over content is kept at publish and every write and judge reads its holders again."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original:
					'\tif (!analyzed.ok) {\n\t\treturn live({ kind: "unrepresentable", refusal: analyzed.error })\n\t}\n',
				replacement: "\tif (!analyzed.ok) {\n\t\tthrow analyzed.error\n\t}\n",
				why: "A definition whose table could not hold its rows refuses the schema, where its definition alone serves every reader."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original:
					"\t\t\tmemberOf: (relation) => owned.unitOf.get(relation) ?? members.get(relation),\n",
				replacement:
					'\t\t\tmemberOf: (relation) =>\n\t\t\t\towned.unitOf.get(relation) ?? members.get(relation) ?? { unit: "Document", fields: ["doc"] },\n',
				why: "A relation in no declared unit read as one, so a relation is stored that no borrow covers a write of."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original: '\t\tnamed.get(relation)?.holding.kind === "stored"\n',
				replacement: "\t\tfalse\n",
				why: "A read of a stored relation reads its definition again, every relation it reads scanned, where its table holds its rows."
			},
			{
				file: "packages/engine/src/analysis/schema.ts",
				original:
					"\t\t\tc !== undefined && this.#tables(relation) && !c.holders.some((holder) => written.has(holder))\n",
				replacement: "\t\t\tc !== undefined && this.#tables(relation)\n",
				why: "A write of Doc reads the stored relation's table, which its own COMMIT replaces: a statement after the write reads rows its earlier statements made stale."
			},
			{
				file: "packages/engine/src/ir/derived.ts",
				original:
					'\t\tif (node.kind === "Base" && replacedBase(node)) {\n\t\t\treturn yield definitionOf(node.relation)\n\t\t}\n',
				replacement: "",
				why: "Every derived relation's Base lowered as a table, a live one's among them, which no installation holds: a read of it reads a relation that does not exist."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\tif (frozen !== undefined) {\n\t\treturn frozen\n\t}\n",
				replacement: "",
				why: "A definition over constants alone kept live: every read evaluates it again, as ledger's TypoTarget, a nested loop of 999 by 645 rows, 297 ms in each grade."
			},
			{
				file: "packages/engine/src/analysis/theory/frozen.ts",
				original: '\t\t\tcase "relation":\n\t\t\t\treturn false\n',
				replacement: '\t\t\tcase "relation":\n\t\t\t\treturn true\n',
				why: "A relation a program writes read as frozen, as a constant given a writer would be: a definition over Doc frozen at the installation, kept by no COMMIT, its rows stale after the first write of Doc."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\tif (width > unit.key.length || f0 === undefined) {",
				replacement: "\tif (f0 === undefined) {",
				why: "A declared unit wider than the definition's admitted: a stored row at one document reads places each written under a borrow of its own."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\tconst relation = stored.find((s) => s.name === r.relation && !s.mutable)",
				replacement: "\t\tconst relation = stored.find((s) => s.name === r.relation)",
				why: "An open relation's own fields read as grizzle's rewrites in place: a definition over an open Doc kept live, though every write of it holds the unit."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\t\t\t\tunit: found.unit,\n\t\t\t\t\t\tfields: delivered.fields,\n",
				replacement:
					"\t\t\t\t\t\tunit: found.unit,\n\t\t\t\t\t\tfields: headNonEmpty(found.unit.holders).fields,\n",
				why: "The stored relation's unit fields read off its first holder's key, not its head: a definition that renames them names fields it does not have."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\tif (k === 1) {\n\t\t\treturn { condition: "hidden", detail: "its head delivers no field that holds its unit" }',
				replacement:
					'\t\tif (k >= 1) {\n\t\t\treturn { condition: "hidden", detail: "its head delivers no field that holds its unit" }',
				why: "A head that hides the widest unit kept live, where a narrower unit it delivers stores it: the document's values, which drop the place, kept live."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\tif (!correlated) {",
				replacement: "\t\tif (correlated === !correlated) {",
				why: "A negation of another document stored, so a stored relation's rows at one document would change with another's."
			},
			{
				file: "packages/engine/src/analysis/theory/query.ts",
				original: '\t\t\tif (s.kind !== "interior") {\n',
				replacement: '\t\t\tif (s.kind !== "interior" || s.kind === "interior") {\n',
				why: "An interior stage read as it stands, not as the closed import of its arms: no walk of the definition reads the stored relation it counts, so ItemDuration's shape is live for reading no stored relation, though the same count as a named query stores."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original:
					"\t(unit.fields.length > unit.declared.fields.length && unitRooted(definition, known, unit)) ||\n",
				replacement:
					"\t(unit.fields.length >= unit.declared.fields.length && unitRooted(definition, known, unit)) ||\n",
				why: "A relation whose unit is no wider than its declared unit stored: its upkeep re-derives the whole unit at every write of it, as edullm's TestAttempt would read a learner's every attempt at each answer."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original:
					"\t(unit.fields.length > unit.declared.fields.length && unitRooted(definition, known, unit)) ||\n",
				replacement: "\tunit.fields.length > unit.declared.fields.length ||\n",
				why: "A unit wider than the declared one admitted whatever it reads: each pair of a place's marks stored, its upkeep at every write of a mark re-deriving every pair of the place, as phase 1's unrooted canonical relations of the ledger ran at every call, 180 to 244 pages for presentedSpans alone."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					"\t\t\t\t\t\t\treturn read.fixed.includes(f) || (bound !== undefined && vars.has(bound))\n",
				replacement: "\t\t\t\t\t\t\treturn bound !== undefined && vars.has(bound)\n",
				why: "A key field a literal holds read as unbound: a place's mark 0 beside its value, under the unit of the place, kept live for its upkeep though it reads one row of Mark at the place, as pantry's attributes of one name, read at their element and the name, would be live at every element of a package."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\t.flatMap(conjunctsOf)\n",
				replacement: "",
				why: "A condition read whole, never by its conjuncts: a mark's number a literal equates inside an and() read as unbound, so a place's mark 0 is live for its upkeep under the unit of the place, as pantry's attributes, their names held in namedIn's and(), went live at every element (74 metis relations at the first census)."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					"\tconst { occurrences, keyedBy, bodies } = unitOccurrences(definition, relations, unit)\n\tconst unitVars = occurrences.flatMap((o) => [...o.unitVars])\n",
				replacement:
					"\tconst { occurrences, keyedBy, bodies: each } = unitOccurrences(definition, relations, unit)\n\tconst bodies = each.length === 0 ? each : [{ ...each[0], members: occurrences.map((_, i) => i), imports: each.flatMap((b) => b.imports), rule: { ...each[0].rule, where: each.flatMap((b) => b.rule.where), head: Object.fromEntries(each.flatMap((b, i) => Object.entries(b.rule.head).map(([k, h]) => [k + String(i), h]))) } }]\n\tconst unitVars = occurrences.flatMap((o) => [...o.unitVars])\n",
				why: "A union's arms rooted together, as one join: the values of each place's low and high marks kept live for its upkeep, no arm's key binding the other's, as metis's AssignmentStatus, four arms over a sitting's events, went live at every learner."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\t\tif (c.kind !== "compare" || c.op !== "eq") {\n\t\t\t\tcontinue\n\t\t\t}\n\t\t\tfor (const [v, e] of [\n',
				replacement:
					"\t\t\tif (c.kind === c.kind) {\n\t\t\t\tcontinue\n\t\t\t}\n\t\t\tfor (const [v, e] of [\n",
				why: "A computed equality read as no determination: each mark beside the mark numbered one more kept live for its upkeep, the second's number bound by n + 1 alone, as ledger's SittingOrder, a suspension beside the next candidate session's visit, went live."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					"\t\tconst next = pending.find((o) => keyedBy(o.read, vars) || successor(o.read))\n",
				replacement: "\t\tconst next = pending.find((o) => keyedBy(o.read, vars))\n",
				why: "A successor read as no determination: each mark's least later mark kept live for its upkeep, though one probe of Mark's order after the mark finds it, as ledger's presentedSpans and presentPieces went live and their readers re-derived a sitting's spans at every read."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\tconst probing = pending.filter((o) =>\n",
				replacement: "\tconst probing = pending.filter((o) => o !== o &&\n",
				why: "An existence test read as a join: each mark a later mark follows kept live for its upkeep, the later mark a witness its head reads nothing of, as metis's laterReports and PausedOver went live."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original:
					'\tif (unit.kind === "unit" && recursive(definition) && !foundedAt(owned, unit.declared.unit)) {\n',
				replacement: '\tif (unit.kind === "unit" && recursive(definition) && false) {\n',
				why: "A recursion over a unit no founding write writes whole admitted as any other definition: the places a document reaches along its links stored, though no write's delta keeps a recursion's rows, so its upkeep could only re-derive the document at every write (lane DELTAUP's dispatch refuses it)."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: '\t\t\t\tread.polarity === "negative" ||\n',
				replacement: "",
				why: "A negated read held to a key like a joined one: each place with no mark, a probe of Mark at the place, kept live for its upkeep under either unit, as metis's Active, an open sitting no submit, abandon or expiry event of it closes, each a probe of its events at the sitting, would be live at every learner."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original:
					"\tunitKeyed(definition, known, unit) ||\n\tfoundedAt(owned, unit.declared.unit)\n",
				replacement: "\tunitKeyed(definition, known, unit) ||\n\ttrue\n",
				why: "Every declared unit read as sealed at founding: a relation over a unit later writes add to stored at the whole unit, its upkeep re-deriving the unit at each of them."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: "\tunitKeyed(definition, known, unit) ||\n",
				replacement: "",
				why: "A relation whose unit key holds a key of every relation it reads kept live, though its upkeep reads one row of each at a key: each place no link leaves under the unit of the document and its place, as rewrite-checks' XsView over T1(doc) under its document, is read through its definition by every reader."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: '\t\t\tif (desc.volatility !== "immutable") {',
				replacement: '\t\t\tif (desc.volatility === "volatile") {',
				why: "A stable function's relation stored, whose value may change with no write, leaving the stored rows stale."
			},
			{
				file: "packages/engine/src/analysis/derived/storage.ts",
				original: "\t\t\t\tpending.push(called)",
				replacement: "\t\t\t\tvoid called",
				why: "The calls closure not followed: an immutable function whose body calls a stable one stored."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\tconst hidden = delivered.kind === "hidden" ? hiddenAt(definition, found, relations) : undefined\n',
				replacement: "\t\tconst hidden = undefined\n",
				why: "A head that hides its unit but determines it is live: metis's DashboardEntry, each sitting's number a learner's by Assignment's key on it, computed whole at every call, where its table, keyed by the learner and the sitting, holds its rows."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: "\t\t\tif (kept.size === 0) {\n\t\t\t\treturn undefined\n\t\t\t}\n",
				replacement: "",
				why: "A head that hides its unit is stored though nothing determines it: two facts of one head in two units are two rows of its table, and a reader reading the head's columns reads the fact twice."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					"\t\t\t\t\t\t\treturn read.fixed.includes(f) || (bound !== undefined && vars.has(bound))\n",
				replacement: "\t\t\t\t\t\t\treturn (holders.get(read.relation) ?? []).includes(f)\n",
				why: "A key is held only where the unit's fields are its fields: a read of Doc at its whole key through the equality that binds the place to the document's variable, den's Requested over Scope(root, root), is unbounded and live, re-derived at every call."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original:
					'\t\tif (delivered.kind === "at" && new Set(delivered.fields).size < delivered.fields.length) {\n\t\t\tcontinue\n\t\t}\n',
				replacement: "",
				why: "A unit whose places one variable binds twice is kept at that width, its key a field twice over, where the document alone is its unit."
			}
		]
	})
