/**
 * unit(name, heading), sealed(unit(...)) and series(R) at the schema door (schema/own.ts ownUnits): a unit holds exactly
 * the stored relations whose primary key leads with its heading's fields, by name and type in order, each relation under
 * one unit at most, stated at or below its members' level; every relation under a sealed unit is closed, it is stated
 * one way, sealed or not, and it states its seal law;
 * a series owns over an immutable relation keyed by one field of a type grizzle draws, natural or a contract over an
 * integer (scalar/natural.ts isDrawnType, drawn's rule), and states its predecessor law. The box is every case of five
 * groups: R keyed leading with the unit's field, with a field of its name and another type, with it second, or with a
 * field of another name; two units nested, over one heading, of one name over two headings, or apart; a unit stated at
 * its member's level or above it; a series over a relation keyed by one natural, by one contract over pg.integer bounded
 * as an int4 serial is, by a natural beside another field, by a bare bigint, or by a contract over a uuid, mutable or
 * not; and a sealed unit over three closed relations, with one of them mutable, over two relations keyed by its key
 * alone, or stated both sealed and not. The oracle restates the rules per case: which schemas own, R's unit and the
 * fields holding its key, the series' law, and the sealed unit's relations and seal law.
 *
 * Features: each case of the space.
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { parseSchemaInput } from "#compiler/program/input.ts"
import { lawsByStatement } from "#compiler/program/laws.ts"
import { refused, succeeded, throwsRefused } from "#test/support/assert.ts"
import { ownInput } from "#test/support/policy.ts"
import {
	builds,
	caseText,
	leads,
	levels,
	mutableSealedRefusal,
	owns,
	pairs,
	schemaOf,
	sealedOwns,
	seals,
	seriesKeys,
	seriesLaw,
	unitCaseGen,
	type UnitFeature,
	unitOfR
} from "#test/unit/schema/units.fixtures.ts"

/** A unit holds exactly the relations whose primary key leads with its heading, one unit a relation, stated at or below them, a sealed unit holds closed relations alone and states its seal law, and a series owns over an immutable relation keyed by one natural or contract over an integer, stating its predecessor law; every other case is refused. */
export const aUnitHoldsExactlyTheRelationsWhoseKeyLeadsWithItsHeadingOneUnitARelationAndASeriesStatesItsPredecessorLaw =
	property.exhaust(finite(unitCaseGen), {
		needs: {},
		situations: [
			...Arr.map(leads, (key) => caseText({ kind: "member", key })),
			...Arr.map(pairs, (pair) => caseText({ kind: "pair", pair })),
			...Arr.map(levels, (at) => caseText({ kind: "level", at })),
			...Arr.flatMap(seriesKeys, (key) =>
				Arr.map([false, true], (m) => caseText({ kind: "series", key, mutable: m }))
			),
			...Arr.map(seals, (seal) => caseText({ kind: "sealed", seal }))
		] satisfies ReadonlyArray<Reached<UnitFeature>>,
		check: (_, k: Case<UnitFeature>) => (c) =>
			Effect.sync(() => {
				k.note(caseText(c))
				if (!builds(c)) {
					const { reason } = throwsRefused(() => schemaOf(c), "Refused", caseText(c))
					assert.equal(
						reason._tag === "Refused" ? reason.refusal : undefined,
						"a series' relation is keyed by one field alone, the series' numbers, of a type grizzle draws: natural or a contract over an integer",
						"series(S)'s refusal"
					)
					return
				}
				const stated = schemaOf(c)
				const owned = Result.flatMap(parseSchemaInput(stated.schema), ownInput)
				if (c.kind === "sealed") {
					const expected = sealedOwns(c.seal)
					if (expected.kind === "refused") {
						const { reason } = refused(owned, expected.tag, caseText(c))
						if (reason._tag === "Refused") {
							assert.equal(
								reason.refusal,
								mutableSealedRefusal,
								"a mutable relation's refusal under a sealed unit"
							)
						}
						return
					}
					const u = succeeded(owned, caseText(c)).units.get("U")
					assert.deepEqual(
						u === undefined
							? undefined
							: { sealed: u.sealed, members: Arr.map(u.members, (m) => m.relation) },
						{ sealed: true, members: Arr.fromIterable(expected.members) },
						"the sealed unit and its relations"
					)
					if (stated.sealed !== undefined) {
						assert.deepEqual(
							Arr.map(lawsByStatement(stated.schema)(stated.sealed), ({ entry: _, ...law }) => law),
							[{ kind: "sealed", unit: "U" }],
							"the sealed unit's seal law"
						)
					}
					return
				}
				if (!owns(c)) {
					refused(owned, "MalformedDescription", caseText(c))
					return
				}
				const schema = succeeded(owned, caseText(c))
				const expected = unitOfR(c)
				const member = schema.unitOf.get("R")
				assert.deepEqual(
					member === undefined
						? undefined
						: { unit: member.unit, fields: Arr.fromIterable(member.fields) },
					expected === undefined
						? undefined
						: { unit: expected.unit, fields: Arr.fromIterable(expected.fields) },
					"R's unit"
				)
				assert.deepEqual(
					Arr.flatMap(Arr.fromIterable(schema.units.values()), (u) =>
						Arr.map(u.members, (m) => m.relation)
					),
					expected === undefined ? [] : ["R"],
					"the units' members"
				)
				if (stated.series !== undefined) {
					const laws = lawsByStatement(stated.schema)(stated.series)
					assert.deepEqual(
						Arr.map(laws, ({ entry: _, ...law }) => law),
						[seriesLaw],
						"the series' law"
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: 'README "Units" restated per case: membership by a key leading with the heading by name and type, no nesting, one name one heading, a unit at or below its members, a sealed unit over closed relations stated one way and stating its seal, a series over an immutable relation keyed by one natural or contract over an integer, stating each number\'s predecessor'
		},
		box: "R keyed leading with a unit's field, with its name at another type, with it second, or by another name; two units nested, over one heading, of one name, or apart; a unit at its member's level or above; a series keyed by one natural, by an int4 contract, wide, by a bigint or by a uuid contract, mutable or not; a sealed unit founded, with a mutable member, over two relations keyed by its key alone, or stated both ways",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/desc.ts",
				original: "return key[at] === f.field && type !== undefined && sameFieldType(type, f.type)",
				replacement: "return key[at] === f.field && type !== undefined",
				why: "A key leads with a heading by its fields' names alone (ir/desc.ts leadsWithHeading), so a field of the name at another type joins the unit."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "if (nests(a.st.heading, b.st.heading)) {",
				replacement: "if (nests(a.st.heading, b.st.heading) && a === b) {",
				why: "Two units one of whose headings leads with the other's admitted (schema/own.ts ownUnits), so a relation sits under both."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "if (a.st.name === b.st.name) {",
				replacement: "if (a.st.name === b.st.name && a === b) {",
				why: "One unit name over two headings admitted (schema/own.ts ownUnits)."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: "if (r.level < level) {",
				replacement: "if (r.level < 0) {",
				why: "A unit stated above a level whose relation leads with its heading admitted (schema/own.ts ownUnits), whose writes a process over that level compiles without the unit."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original: 'if (st.kind === "series" && relations[st.relation]?.mutable === true) {',
				replacement: 'if (st.kind === "series" && relations[st.relation]?.mutable === undefined) {',
				why: "A series over a mutable relation admitted (schema/own.ts ownUnits)."
			},
			{
				file: "packages/engine/src/ir/desc.ts",
				original: 'from: { kind: "pred", field: s.field },',
				replacement: 'from: { kind: "field", field: s.field },',
				why: "The series' law states each number in the series rather than its predecessor (ir/desc.ts seriesPair), so a gap passes."
			},
			{
				file: "packages/engine/src/schema/statements.ts",
				original:
					"if (field === undefined || rest.length > 0 || !isDrawnType(fieldOf(rel, field, label))) {",
				replacement:
					"if (field === undefined || rest.length > 0 || !isNaturalDesc(fieldOf(rel, field, label))) {",
				why: "A series keyed by natural alone (schema/statements.ts admitSeries), so a contract over an integer, an int4 test number, is refused where drawn(c) takes it."
			},
			{
				file: "packages/engine/src/scalar/natural.ts",
				original: 'desc.kind === "contract" && !isInstantDesc(desc) && isIntegerDesc(desc.base)',
				replacement: 'desc.kind === "contract" && !isInstantDesc(desc)',
				why: "A drawn type any contract but instant (scalar/natural.ts isDrawnType), so a series keyed by a contract over a uuid is admitted."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original:
					"Object.freeze(st.sealed ? { ...parts, sealed: true, entry } : { ...parts, sealed: false })",
				replacement:
					"Object.freeze(false ? { ...parts, sealed: true, entry } : { ...parts, sealed: false })",
				why: "Ownership owns every unit unsealed, whatever its statement states (schema/own.ts ownUnits), so a sealed unit installs no seal and states no seal law; the founded case fails."
			},
			{
				file: "packages/engine/src/schema/own.ts",
				original:
					'if (st.kind === "mutable" && under !== undefined && units.get(under.unit)?.sealed === true) {',
				replacement:
					'if (st.kind === "mutable" && under !== undefined && units.get(under.unit)?.sealed === undefined) {',
				why: "A relation mutable under a sealed unit admitted (schema/own.ts ownUnits), so a later transaction changes a founded row in place."
			}
		]
	})
