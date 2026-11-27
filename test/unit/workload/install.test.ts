/**
 * The workload in the installation (physical/access withWorkload): access requests merge with law maintenance against the
 * key and law indexes, every installed index and statistics object stands on a law id or the workload's access, and
 * the installation of any sub-workload of the worked example holds exactly the objects of the whole workload's that the
 * laws alone install or one of its own programs asks for, as installing each of those programs alone asks for it (its
 * access's objects and its parameters' types), and
 * the laws' own index where the whole workload's serving one is wider for programs the sub-workload drops: a law's
 * request lands on a wider index a program asks for, and on an index of its own without one (physical/indexes/engine.ts
 * planIndexes). It stands on every law the laws alone stand on.
 *
 * A workload that cannot install is refused with its reason. Each case draws the worked example or Board, a workload of
 * drawn programs of its fixtures, and at most one defect: a workload compiled over the other schema, a path on a
 * relation the schema does not store (MalformedDescription), or a prefix search over a drawn text field of the worked
 * example, refused (UnrepresentableKey) exactly where its pattern bounds no length, the wildcard; the healthy workload
 * installs.
 *
 * Oracles: the installations of the whole workload, of the laws alone and of each program alone (a second
 * implementation of a sub-workload's objects); the specification of each defect's refusal.
 *
 * Features: an index only removed programs asked for, a key or law object a kept program asks for too, an index a kept
 * program asks for alone, a law's own index where the whole workload's is wider for a dropped program, the empty
 * workload; each defect and the healthy workload.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option, Order, Record as Rec } from "effect"
import { refused, succeeded } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { planOf } from "#test/unit/workload/fixtures.ts"
import {
	all,
	alone,
	hasAccess,
	hasLaw,
	type InstallFeature,
	installCaseGen,
	installOf,
	installWith,
	justified,
	lawsAlone,
	lawsAloneIdents,
	lawsOf,
	type SubFeature,
	subWorkloadGen,
	wholeIdents
} from "#test/unit/workload/install.fixtures.ts"

/**
 * The worked example's workload in the installation holds exactly the objects a law stands on or one of the workload's
 * own programs asks for, byte for byte the same.
 *
 * Budget: its suite's count before the conversion (unit/workload/install-sub: 20 independent cases and 16 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const theWorkedExamplesWorkloadInTheInstallationHoldsExactlyTheObjectsALawStandsOnOrOneOfTheWorkloadsOwnProgramsAsksForByteForByteTheSame =
	property.explore(subWorkloadGen, {
		needs: {},
		situations: [
			"an index only removed programs asked for",
			"a key or law object a kept program asks for too",
			"an index a kept program asks for alone",
			"a law's own index, where the whole workload's is wider for a dropped program",
			"the empty workload"
		] satisfies ReadonlyArray<Reached<SubFeature>>,
		check: (_, c: Case<SubFeature>) => (kept) =>
			Effect.sync(() => {
				const sub = succeeded(
					installWith(W.Work, planOf(W.Work, Rec.fromEntries(kept))),
					"a sub-workload installs"
				)
				for (const o of justified(sub)) {
					assert.ok(hasLaw(o.reasons) || hasAccess(o.reasons), `${o.ident} stands on nothing`)
				}
				const asked = new Set(
					Arr.flatMap(kept, ([name]) => [...defined(alone.get(name), name).asked])
				)
				const askedAccess = new Set(
					Arr.flatMap(kept, ([name]) => [...defined(alone.get(name), name).access])
				)
				/**
				 * The whole workload's objects the laws alone install or a kept program asks for, each standing on the
				 * access only where a kept program asks for it: one only the access stands on goes with the programs that
				 * asked for it.
				 */
				const keptWhole = Arr.filter(all.manifest.objects, (o) => {
					const access = askedAccess.has(o.ident)
					const standsElsewhere = Arr.some(o.reasons, (r) => r.kind !== "access")
					if (standsElsewhere && access) {
						c.note("a key or law object a kept program asks for too")
					}
					if (!standsElsewhere && access) {
						c.note("an index a kept program asks for alone")
					}
					if (!standsElsewhere && !access) {
						c.note("an index only removed programs asked for")
					}
					return asked.has(o.ident) || lawsAloneIdents.has(o.ident)
				})
				/** The laws a kept program's object serves beside it, an object the laws alone do not install. */
				const widened = new Set(lawsOf(Arr.filter(keptWhole, (o) => !lawsAloneIdents.has(o.ident))))
				/**
				 * The laws alone's objects the whole workload holds none of, whose laws no kept program's object serves: a
				 * law's own index, where the whole workload's serving one is wider for programs the sub-workload drops.
				 */
				const lawsOwn = Arr.filter(lawsAlone.manifest.objects, (o) => {
					const own =
						!wholeIdents.has(o.ident) &&
						Arr.every(o.reasons, (r) => r.kind !== "law" || !widened.has(r.law))
					if (own) {
						c.note("a law's own index, where the whole workload's is wider for a dropped program")
					}
					return own
				})
				const byIdent = Order.mapInput(Order.String, (o: { readonly ident: string }) => o.ident)
				assert.deepEqual(
					Arr.sort(
						Arr.map(sub.manifest.objects, (o) => ({
							ident: o.ident,
							access: hasAccess(o.reasons)
						})),
						byIdent
					),
					Arr.sort(
						Arr.map([...keptWhole, ...lawsOwn], (o) => ({
							ident: o.ident,
							access: askedAccess.has(o.ident)
						})),
						byIdent
					)
				)
				assert.deepEqual(lawsOf(sub.manifest.objects), lawsOf(lawsAlone.manifest.objects))
				/** The same workload listed in reverse installs the same statements. */
				const reversed = succeeded(
					installWith(W.Work, planOf(W.Work, Rec.fromEntries(Arr.reverse(kept))))
				)
				assert.deepEqual(reversed.statements, sub.statements)
				if (kept.length === 0) {
					c.note("the empty workload")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the whole workload's installation, the laws' alone and each program's alone: a sub-workload's objects are exactly those"
		},
		budget: { runs: 20, steered: 16 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/workload/install.test.ts#theWorkedExamplesWorkloadInTheInstallationHoldsExactlyTheObjectsALawStandsOnOrOneOfTheWorkloadsOwnProgramsAsksForByteForByteTheSame:-:0"
				),
				reason: "the empty workload",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\tb.graph.addReasons(candidate.index.object, [reasonOf(entry.request)])",
				replacement: "\t\t\tb.graph.addReasons(candidate.index.object, [])",
				why: "A request that lands on an index already planned adds no reason to it (indexes/engine.ts planIndexes), so a key or law index a program asks for stands on no access; the sub-workload property fails."
			}
		]
	})

/**
 * A workload that cannot install is refused with its reason: another schema's, a path off its schema, an unbounded
 * prefix search.
 *
 * Budget: its suite's count before the conversion (unit/workload/install-refused: 40 independent cases and 32 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const aWorkloadThatCannotInstallIsRefusedWithItsReasonAnotherSchemasAPathOffItsSchemaAnUnboundedPrefixSearch =
	property.explore(installCaseGen, {
		needs: {},
		situations: [
			"none",
			"a workload over another schema",
			"a path on a relation the schema does not store",
			"a prefix search over a bounded text",
			"a prefix search over the wildcard",
			"admitted over Board"
		] satisfies ReadonlyArray<Reached<InstallFeature>>,
		check: (_, k: Case<InstallFeature>) => (c) =>
			Effect.sync(() => {
				k.note(c.defect.kind)
				const { schema, physical, refusal } = installOf(c)
				if (c.defect.kind === "a prefix search") {
					k.note(
						Option.isSome(refusal)
							? "a prefix search over the wildcard"
							: "a prefix search over a bounded text"
					)
				}
				const installed = installWith(schema, physical)
				if (Option.isSome(refusal)) {
					refused(installed, refusal.value)
					return
				}
				if (!c.work) {
					k.note("admitted over Board")
				}
				succeeded(installed, "an installable workload installs")
			}),
		oracle: {
			kind: "specification",
			name: "a workload installs only on its own schema, with paths on relations it stores, and keys whose B-tree entry its patterns bound"
		},
		budget: { runs: 40, steered: 32 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/program/workload/compile.ts",
				original: "\textractAccess(ir.roots, {\n",
				replacement: "\textractAccess([], {\n",
				why: "A program's IR asks no path (irAccess): the prefix search over the wildcard text asks no index, nothing refuses its key, and the workload installs where its B-tree entry is unbounded."
			}
		]
	})
