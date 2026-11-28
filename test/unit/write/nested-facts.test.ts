/**
 * A nested addition's facts, as a JavaScript caller states them, hold the fields their caller writes at every depth, as
 * its type says (AdditionIn): a fact that states a field grizzle draws or accumulates, or one its relation lacks, is
 * refused before any SQL by its level's normalizer, an EncodingFailure of factShape. The split of an addition along its
 * families (runtime/write/addition.ts additionSplitter) keeps every field a fact states but its count fields, where it
 * used to drop a drawn or accumulated field unsaid, its value lost.
 *
 * The schema: an owner of an ordered family with a sum fold, so the owner has an accumulated end and each member a
 * drawn index. A case draws one or two owners, each with one to three members nested, and each fact states, beside the
 * fields its caller writes, its drawn or accumulated field or not, and a field its relation lacks (a dictionary name
 * outside both headings, drawn from the dictionary with the headings cut out) or not, each with a drawn value. The
 * oracle is the type's contract, a specification: the insertion binds exactly when no fact at any depth states a field
 * beyond its caller's, and is refused as factShape otherwise.
 *
 * Features: the owner states its accumulated end, a member its drawn index; the owner, or a member, states a field its
 * relation lacks; only a later member states beyond its caller's fields; every fact states its caller's fields alone.
 */

import { assert, assertVariant } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import { bindWrite } from "#compiler/runtime/write/bind.ts"
import { inForce } from "#compiler/runtime/write/transport.ts"
import { noAdvice } from "#compiler/sql/advice.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf, servableWrite } from "#compiler/write/program/served.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf } from "#test/support/unit/write/changeset/fixtures.ts"
import { withinMessage } from "#test/support/worlds/execute/offline.ts"
import {
	additionsGen,
	additionsOf,
	beyondAny,
	type NestedFeature,
	Owner,
	reality,
	Sequenced
} from "#test/unit/write/nested-facts.fixtures.ts"

/**
 * A nested addition's facts bind exactly when every fact states its caller's fields alone, refusing a drawn,
 * accumulated or foreign field at any depth.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/write/nested-facts.test.ts:167 at 8cad5bce, its runs and its coverage's cases).
 */
export const aNestedAdditionsFactsBindExactlyWhenEveryFactStatesItsCallersFieldsAloneRefusingADrawnAccumulatedOrForeignFieldAtAnyDepth =
	property.explore(additionsGen, {
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: [
			"the owner states its accumulated end",
			"a member states its drawn index",
			"the owner states a field its relation lacks",
			"a member states a field its relation lacks",
			"only a later member states beyond its caller's fields",
			"every fact states its caller's fields alone"
		] satisfies ReadonlyArray<Reached<NestedFeature>>,
		check: (_, c: Case<NestedFeature>) => (owners) =>
			Effect.sync(() => {
				const value = ChangeSet.empty(Sequenced).insert(Owner, additionsOf(owners))
				const program = succeeded(compileWrite(checking(Sequenced), descOf(value), reality))
				const members = collectInputs(program.binding.groups, parsedOf(value).inputs)
				const bound = withinMessage(
					bindWrite(flightOf(servableWrite(program), program.frontend.codes, noAdvice), {
						members,
						params: {},
						transport: inForce(bindFrame)
					})
				)
				const memberFacts = Arr.flatMap(owners, (o) => o.members)
				if (Arr.some(owners, (o) => Option.isSome(o.beyond.written))) {
					c.note("the owner states its accumulated end")
				}
				if (Arr.some(memberFacts, (m) => Option.isSome(m.beyond.written))) {
					c.note("a member states its drawn index")
				}
				if (Arr.some(owners, (o) => Option.isSome(o.beyond.foreign))) {
					c.note("the owner states a field its relation lacks")
				}
				if (Arr.some(memberFacts, (m) => Option.isSome(m.beyond.foreign))) {
					c.note("a member states a field its relation lacks")
				}
				const owned = Arr.some(owners, (o) => beyondAny(o.beyond))
				const firsts = Arr.some(owners, (o) => beyondAny(Arr.headNonEmpty(o.members).beyond))
				const later = Arr.some(owners, (o) =>
					Arr.some(Arr.tailNonEmpty(o.members), (m) => beyondAny(m.beyond))
				)
				if (!owned && !firsts && later) {
					c.note("only a later member states beyond its caller's fields")
				}
				if (!owned && !firsts && !later) {
					c.note("every fact states its caller's fields alone")
					assertVariant(succeeded(bound), "kind", "bound", "the caller's fields bind")
					return
				}
				const failure = refused(
					bound,
					"factShape",
					"a fact holds the fields its caller writes, refused before any SQL"
				)
				assert.equal(failure._tag, "EncodingFailure", "the caller's input is refused")
			}),
		oracle: {
			kind: "specification",
			name: "AdditionIn: a fact states the fields its caller writes, at every depth"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/runtime/write/addition.ts",
				original:
					"\t\tconst own = Object.freeze(\n\t\t\tObject.fromEntries(Object.entries(read.value).filter(([name]) => !counts.has(name)))\n\t\t)",
				replacement:
					"\t\tconst stated = Object.entries(read.value).filter(([name]) => !counts.has(name))\n\t\tconst own = Object.freeze(Object.fromEntries(next.at === undefined ? stated : stated.slice(0, 1)))",
				why: "The split keeps a nested member's first field alone (runtime/write/addition.ts additionSplitter), so a drawn index or a foreign field is dropped unsaid."
			}
		]
	})
