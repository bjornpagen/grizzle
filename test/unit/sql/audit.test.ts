/**
 * The test kernel's structural audit of emitted SQL (test/support/oracle/verify/sql.ts), searched over Live statements
 * and their Wild breaks.
 *
 * The Live statements (audit/live.ts) are the kernel generator's statements, the lowering of generated query cases,
 * the installations and drafted migrations of the fixture schemas, and the compilations of generated write programs.
 * On every one of them:
 *
 * - both audits admit it, its twin built apart prints alike, the snapshot's own codec (the persisted statement
 *   schema's encoding, which reads it through the type side first, and writeJsonText, then canonical decode and the
 *   schema's decoding) reads it back as itself, emit prints it, and the audit hands back the type of each placeholder
 *   at its index;
 * - a lowered or written statement's text is its AST's print, and lowering or compiling the case again, or its twin,
 *   emits the same texts byte for byte.
 *
 * Its Wild breaks (audit/operators.ts) each break one rule at one site of one statement, picked by kind first so a
 * kind every draw holds once is reached as often as one it holds sixty times, and, where a case's sketch aims at the
 * situations still pending when it was drawn, among the statements holding a site of one: the statement audit reports
 * that rule and no other, under the reason the rule maps to (MalformedDescription for structure, UnsupportedOperation
 * for the emission discipline).
 * Its faithful rewrites are admitted and print as declared.
 * Its print, broken at one token, is reported by the text audit as exactly the rule broken.
 *
 * Oracle: the universal laws of a statement (its twin prints alike, the snapshot's codec reads it back, emit prints
 * it, lowering again emits the same text); each break's rule and reason as the operator declares it (a mutation
 * oracle).
 *
 * Features: each source, context, statement kind and shape of the Live population; each required break and rule; each
 * required faithful rewrite; each text break and its rule beside the print's leading words.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { printStatement } from "#compiler/sql/print.ts"
import { shapeFeatures, shapeOf } from "#test/support/kernel/shape.ts"
import { breaks, oneHole } from "#test/support/kernel/sqlgen.ts"
import {
	auditStatementViolations,
	auditTextViolations,
	violationError
} from "#test/support/oracle/verify/sql.ts"
import { pickFrom } from "#test/support/pick.ts"
import {
	type AuditLiveFeature,
	auditLiveFeatures,
	breakAims,
	breakCaseOf,
	type BreakFeature,
	breakReaching,
	breakSituations,
	candidates,
	clip,
	type FaithfulFeature,
	faithfulReaching,
	faithfulSituations,
	liveSituations,
	marksMet,
	noteReached,
	pickedStatement,
	ruleSet,
	type TextBreakFeature,
	textBreakSituations,
	textReaching,
	universal,
	writesWhere,
	writtenSituations
} from "#test/unit/sql/audit.fixtures.ts"
import {
	breakSketchGen,
	liveSketchGen,
	resolveLive,
	writtenSketchGen,
	writtenStandUps
} from "#test/unit/sql/audit/live.ts"
import {
	auditRuleReason,
	faithfulRewrites,
	statementBreaks,
	textBreaks
} from "#test/unit/sql/audit/operators.ts"

/**
 * Every Live statement passes both audits, prints as its twin does, survives the snapshot's codec and emit, and lowers
 * deterministically.
 *
 * Budget: 120 runs and 120 steered cases, what its suite stated before it became a property
 * (test/unit/sql/audit.test.ts:416 at 8cad5bce, its runs and its coverage's cases).
 */
export const everyLiveStatementPassesBothAuditsPrintsAsItsTwinDoesSurvivesTheSnapshotsCodecAndEmitAndLowersDeterministically =
	property.explore(liveSketchGen, {
		needs: {},
		budget: { runs: 120, steered: 120 },
		situations: liveSituations satisfies ReadonlyArray<Reached<AuditLiveFeature>>,
		check: (_, c: Case<AuditLiveFeature>) => (sketch) =>
			Effect.sync(() => {
				const live = resolveLive(sketch)
				for (const twinned of live.statements) {
					universal(twinned)
				}
				c.noteAll(auditLiveFeatures(live))
				for (const { ast, text } of live.emitted) {
					assert.equal(text, printStatement(ast), "the emitted text is its AST's print")
				}
				const [first, ...runs] = live.again()
				if (first !== undefined) {
					for (const run of runs) {
						assert.deepEqual(run, first, "lowering the case again emits the same texts")
					}
				}
			}),
		oracle: {
			kind: "universal",
			name: "both audits admit it, its twin prints alike, the codec and emit read it back, lowering again emits the same text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/emit.ts",
				original: "\ttext: emitted(printStatement(statement)),",
				replacement: `\ttext: emitted(\`\${printStatement(statement)} \`),`,
				why: "An emitted text carries a trailing space (sql/emit.ts); the Live and the written statements' searches fail."
			}
		]
	})

/**
 * Every statement a generated write program places passes both audits, prints as its twin does, survives the
 * snapshot's codec and emit, and compiles deterministically; and so does every statement its session stands up before
 * its first call, each carrier and its emptying, whose kinds and shapes the case does not note, so they steer nothing.
 *
 * Budget: 60 runs and 60 steered cases, what its suite stated before it became a property
 * (test/unit/sql/audit.test.ts:486 at 8cad5bce, its runs and its coverage's cases).
 */
export const everyStatementAGeneratedWriteProgramPlacesPassesBothAuditsPrintsAsItsTwinDoesSurvivesTheSnapshotsCodecAndEmitAndCompilesDeterministically =
	property.explore(writtenSketchGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: writtenSituations satisfies ReadonlyArray<Reached<AuditLiveFeature>>,
		check: (_, c: Case<AuditLiveFeature>) => (sketch) =>
			Effect.sync(() => {
				const live = resolveLive(sketch)
				c.noteAll(live.features)
				for (const twinned of live.statements) {
					universal(twinned)
					c.note(`statement ${twinned.statement.kind}`)
					c.noteAll(shapeFeatures(shapeOf(twinned.statement)))
					if (writesWhere(twinned.statement, marksMet)) {
						c.note("old under IS TRUE in an INSERT's RETURNING")
					}
				}
				for (const stood of writtenStandUps(sketch.sketch)) {
					universal(stood)
				}
				for (const { ast, text } of live.emitted) {
					assert.equal(text, printStatement(ast), "the placed text is its AST's print")
				}
				const [first, ...runs] = live.again()
				if (first !== undefined) {
					for (const run of runs) {
						assert.deepEqual(run, first, "compiling the program again places the same texts")
					}
				}
			}),
		oracle: {
			kind: "universal",
			name: "both audits admit it, its twin prints alike, the codec and emit read it back, compiling again places the same text"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/emit.ts",
				original: "\ttext: emitted(printStatement(statement)),",
				replacement: `\ttext: emitted(\`\${printStatement(statement)} \`),`,
				why: "An emitted text carries a trailing space (sql/emit.ts); the Live and the written statements' searches fail."
			},
			{
				file: "packages/engine/src/write/family/scan.ts",
				original: "\tderived(layer.query, alias, layer.columns, false)",
				replacement: "\tderived(layer.query, alias, [], false)",
				why: "A family scan's layer lists no column (write/family/scan.ts), so its derived table names none; the written statements' search fails."
			},
			{
				file: "packages/engine/src/write/insert/protocol.ts",
				original: "\t\t\t\t\t\t...outFields.map((f) => targetAs(requested(f), retCol(f))),",
				replacement: "\t\t\t\t\t\t...outFields.map((f) => target(requested(f))),",
				why: "The same-key pair's arm of an insert's verdict UNION ALL leaves its fact columns unnamed (write/insert/protocol.ts paired); the written statements' search fails."
			}
		]
	})

/**
 * A statement broken at one site is refused by the audit for exactly the rule it breaks, under that rule's reason.
 *
 * Budget: 300 runs and 600 steered cases, what its suite stated before it became a property
 * (test/unit/sql/audit.test.ts:553 at 8cad5bce, its runs and its coverage's cases).
 */
export const aStatementBrokenAtOneSiteIsRefusedByTheAuditForExactlyTheRuleItBreaksUnderThatRulesReason =
	property.explore(
		aimed(
			breakCaseOf<BreakFeature>(breakSketchGen, statementBreaks.length, []),
			breakAims(breakReaching, breakSituations)
		),
		{
			needs: {},
			budget: { runs: 300, steered: 600 },
			situations: breakSituations satisfies ReadonlyArray<Reached<BreakFeature>>,
			check:
				(_, c: Case<BreakFeature>) =>
				({ live: sketch, statement, sites, aims }) =>
					Effect.sync(() => {
						const live = resolveLive(sketch)
						const s = pickedStatement(candidates(live, aims, breakReaching), statement)
						const problems: Array<string> = []
						for (const [i, operator] of statementBreaks.entries()) {
							const [first, ...rest] = breaks(s, operator)
							if (first === undefined) {
								continue
							}
							const rewrite = pickFrom(
								[first, ...rest],
								defined(sites[i], "a site drawn per break")
							)
							const found = auditStatementViolations(rewrite.statement)
							const got = ruleSet(found)
							if (got !== operator.rule) {
								problems.push(
									`${operator.name} (${rewrite.kind} ${rewrite.site}): reported [${got}], not [${operator.rule}]\n${clip(printStatement(rewrite.statement))}`
								)
								continue
							}
							const [violation] = found
							if (violation === undefined) {
								problems.push(`${operator.name}: the audit admitted it`)
								continue
							}
							const reason = auditRuleReason[operator.rule]
							const refused = violationError(violation, "statement").reason._tag
							if (refused !== reason) {
								problems.push(`${operator.name}: refused as ${refused}, not ${reason}`)
							}
							for (const situation of breakReaching.reaches(s, operator)) {
								noteReached(c, situation)
							}
						}
						assert.deepEqual(problems, [], `${live.label}\n${clip(printStatement(s))}`)
					}),
			oracle: {
				kind: "specification",
				name: "each break refused for exactly the rule it declares, under that rule's reason"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/sql/transform.ts",
					original:
						"\t\t\t\t\treturn condition === b.condition && body === b.body ? b : { ...b, condition, body }",
					replacement:
						"\t\t\t\t\treturn condition !== b.condition && body === b.body ? b : { ...b, condition, body }",
					why: "Operator mutant (comparison) at packages/engine/src/sql/transform.ts:1088 in <module>: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)

/**
 * A statement broken at one site is admitted when the rewrite is faithful, and prints as the rewrite declares.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/sql/audit.test.ts:625 at 8cad5bce, its runs and its coverage's cases).
 */
export const aStatementBrokenAtOneSiteIsAdmittedWhenTheRewriteIsFaithfulAndPrintsAsTheRewriteDeclares =
	property.explore(
		aimed(
			breakCaseOf<FaithfulFeature>(liveSketchGen, faithfulRewrites.length, []),
			breakAims(faithfulReaching, faithfulSituations)
		),
		{
			needs: {},
			budget: { runs: 300, steered: 300 },
			situations: faithfulSituations satisfies ReadonlyArray<Reached<FaithfulFeature>>,
			check:
				(_, c: Case<FaithfulFeature>) =>
				({ live: sketch, statement, sites, aims }) =>
					Effect.sync(() => {
						const live = resolveLive(sketch)
						const s = pickedStatement(candidates(live, aims, faithfulReaching), statement)
						const before = printStatement(s)
						const problems: Array<string> = []
						for (const [i, r] of faithfulRewrites.entries()) {
							const [first, ...rest] = oneHole(s, r.holes)
							if (first === undefined) {
								continue
							}
							const v = pickFrom(
								[first, ...rest],
								defined(sites[i], "a site drawn per rewrite")
							).statement
							const found = auditStatementViolations(v)
							const after = printStatement(v)
							if (found.length > 0) {
								problems.push(`${r.name}: refused [${ruleSet(found)}]\n${clip(after)}`)
							}
							if (r.print === "different" && after === before) {
								problems.push(`${r.name}: prints as the statement it rewrote`)
							}
							for (const situation of faithfulReaching.reaches(s, r)) {
								noteReached(c, situation)
							}
						}
						assert.deepEqual(problems, [], `${live.label}\n${clip(before)}`)
					}),
			oracle: {
				kind: "specification",
				name: "each faithful rewrite admitted, printing as it declares"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/sql/transform.ts",
					original: "\t\treturn query === c.query ? c : { ...c, query }",
					replacement: "\t\treturn query !== c.query ? c : { ...c, query }",
					why: "Operator mutant (comparison) at packages/engine/src/sql/transform.ts:630 in <module>: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)

/**
 * A printed statement broken at one token is refused by the text audit for exactly the rule it breaks.
 *
 * Budget: 400 runs and 400 steered cases, what its suite stated before it became a property
 * (test/unit/sql/audit.test.ts:687 at 8cad5bce, its runs and its coverage's cases).
 */
export const aPrintedStatementBrokenAtOneTokenIsRefusedByTheTextAuditForExactlyTheRuleItBreaks =
	property.explore(
		aimed(
			breakCaseOf<TextBreakFeature>(breakSketchGen, textBreaks.length, []),
			breakAims(textReaching, textBreakSituations)
		),
		{
			needs: {},
			budget: { runs: 400, steered: 400 },
			situations: textBreakSituations satisfies ReadonlyArray<Reached<TextBreakFeature>>,
			check:
				(_, c: Case<TextBreakFeature>) =>
				({ live: sketch, statement, sites, aims }) =>
					Effect.sync(() => {
						const live = resolveLive(sketch)
						const s = pickedStatement(candidates(live, aims, textReaching), statement)
						const printed = printStatement(s)
						const problems: Array<string> = []
						for (const [i, b] of textBreaks.entries()) {
							const [v, ...vs] = b.variants(printed)
							if (v === undefined) {
								continue
							}
							const broken = pickFrom([v, ...vs], defined(sites[i], "a site drawn per text break"))
							const got = ruleSet(auditTextViolations(broken))
							if (got !== b.rule) {
								problems.push(`${b.name}: reported [${got}], not [${b.rule}]\n${clip(broken)}`)
							}
							for (const situation of textReaching.reaches(printed, b)) {
								noteReached(c, situation)
							}
						}
						assert.deepEqual(problems, [], `${live.label}\n${clip(printed)}`)
					}),
			oracle: {
				kind: "specification",
				name: "each text break refused by the text audit for exactly the rule it declares"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/sql/lexer.ts",
					original: "\t\t\tout += text.slice(from, k) + String.fromCharCode(c - 32)",
					replacement: "\t\t\tout += text.slice(from, k) + String.fromCharCode(c - 31)",
					why: "Operator mutant (bound) at packages/engine/src/sql/lexer.ts:151 in toUpperAscii: `32` becomes `31`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)
