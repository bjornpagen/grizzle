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
 * for the emission discipline); a scope break, a name read where nothing binds it, is the printer's to refuse
 * (sql/scope.ts), so the audit reports nothing, the scope check exactly the escape the break plants, and the printer
 * refuses to print it, holding the statement as the lowering built it, before print once flattens a sub-query that
 * names an earlier FROM entry away.
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
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { printStatement } from "#compiler/sql/print.ts"
import { scopeEscapes } from "#compiler/sql/scope.ts"
import {
	carrierFills,
	carrierReads,
	carrierReadsOutsideRowsFrom
} from "#test/support/carrier-reads.ts"
import { shapeFeatures, shapeOf } from "#test/support/kernel/shape.ts"
import { breaks, oneHole } from "#test/support/kernel/sqlgen.ts"
import {
	auditStatementViolations,
	auditTextViolations,
	guardedTermsOf,
	violationError
} from "#test/support/oracle/verify/sql.ts"
import { pickFrom } from "#test/support/pick.ts"
import { servable, sessionObjectsNamed } from "#test/support/session-objects.ts"
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
	printerRefuses,
	ruleSet,
	scopeRuleSet,
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
	writtenSketchGen
} from "#test/unit/sql/audit/live.ts"
import {
	auditRuleReason,
	faithfulRewrites,
	isScopeRule,
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
 * snapshot's codec and emit, and compiles deterministically; and no statement it places names an object of its
 * session: a carrier travels in its transaction's settings (write/carriers/carriers.ts), filled by set_config and read
 * by current_setting, so every statement's text is its program's alone and one statement, one queryid, in every
 * session.
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
					if (carrierReads(twinned.statement).size > 0) {
						c.note("a carrier read")
					}
					if (carrierFills(twinned.statement).size > 0) {
						c.note("a carrier filled")
					}
				}
				for (const twinned of Arr.filter(live.statements, (t) => servable(t.statement))) {
					assert.deepEqual(
						sessionObjectsNamed(twinned.statement),
						[],
						"a served statement names no object of its session: its text is its program's alone, one statement in every session"
					)
					assert.deepEqual(
						carrierReadsOutsideRowsFrom(printStatement(twinned.statement)),
						[],
						"a served statement reads every carrier through one ROWS FROM function scan, never a select list's unnest a rescan evaluates again"
					)
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
				original: "\t\t\t\t\t...ready.map(({ expr, name: n }) => targetAs(expr, n))",
				replacement: '\t\t\t\t\t...ready.map(({ expr, name: n }) => targetAs(expr, n + "_drawn"))',
				why: "A family scan's layer names the columns it draws other than as the scan names them (write/family/scan.ts), so the layer above reads no column of its by those names; the written statements' search fails."
			},
			{
				file: "packages/engine/src/write/insert/protocol.ts",
				original: "\t\t\t\t\t\t...outFields.map((f) => targetAs(requested(f), retCol(f))),",
				replacement: "\t\t\t\t\t\t...outFields.map((f) => target(requested(f))),",
				why: "The same-key pair's arm of an insert's verdict UNION ALL leaves its fact columns unnamed (write/insert/protocol.ts paired); the written statements' search fails."
			},
			{
				file: "packages/engine/src/sql/carriers.ts",
				original: "): FromSource => {\n\tif (!isNonEmpty(columns)) {\n",
				replacement:
					'): FromSource => {\n\tif (columns.length >= 0) {\n\t\treturn { kind: "table", table: { schema: "pg_temp", name: carrier }, alias }\n\t}\n\tif (!isNonEmpty(columns)) {\n',
				why: "A statement reads its carrier from a table of its session's own temporary schema, as format 8 did: its text names a session object, so its identity, its queryid, is its session's, a new statement in each session; the written statements' search fails."
			}
		]
	})

/**
 * A statement broken at one site is refused by the audit for exactly the rule it breaks, under that rule's reason, or,
 * broken in its scope, by the printer for exactly the escape it plants.
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
							const escapes = scopeEscapes(rewrite.statement)
							const got = Arr.join(
								Arr.filter([ruleSet(found), scopeRuleSet(escapes)], (r) => r !== ""),
								", "
							)
							if (got !== operator.rule) {
								problems.push(
									`${operator.name} (${rewrite.kind} ${rewrite.site}): reported [${got}], not [${operator.rule}]\n${escapes.length > 0 ? `${escapes.length} escapes, the first at ${escapes[0]?.at}` : clip(printStatement(rewrite.statement))}`
								)
								continue
							}
							if (isScopeRule(operator.rule)) {
								if (!printerRefuses(rewrite.statement)) {
									problems.push(`${operator.name}: the printer printed it`)
								}
								for (const situation of breakReaching.reaches(s, operator)) {
									noteReached(c, situation)
								}
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
					file: "packages/engine/src/sql/print-once.ts",
					original: "\tassertScoped(statement)\n",
					replacement: "",
					why: "The printer prints a statement without its scope check: every scope break is printed, a text PostgreSQL refuses (42P01, 42703), and the property fails."
				},
				{
					file: "packages/engine/src/sql/scope.ts",
					original: '\twalked({ kind: "statement", statement }, new Set()).escapes\n',
					replacement: "\t[]\n",
					why: "The scope check finds no escape: no scope break is refused, at the printer or apart, and the property fails."
				},
				{
					file: "packages/engine/src/sql/scope.ts",
					original:
						"\t\treturn binder.index >= binder.frame.lo && binder.index < binder.frame.hi\n",
					replacement: "\t\treturn true\n",
					why: "Every name a frame binds reaches every place under it: a FROM item that is not LATERAL reads its siblings, a write's FROM its target and a MERGE's WHEN the side its match lacks, and the property fails."
				},
				{
					file: "packages/engine/src/sql/scope.ts",
					original: "\t\t\t\t\t\tframe.reachFrom(start)\n",
					replacement: "\t\t\t\t\t\tframe.reachFrom(lo)\n",
					why: "A join's ON reaches the FROM items before its chain, which PostgreSQL refuses (42P01), and the property fails."
				},
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
							const got = ruleSet(auditTextViolations(broken, guardedTermsOf(s)))
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
			kept: [
				{
					token: ReplayToken(
						"test/unit/sql/audit.test.ts#aPrintedStatementBrokenAtOneTokenIsRefusedByTheTextAuditForExactlyTheRuleItBreaks@small-stack:-:2.9.rkz.15dh.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
					),
					reason:
						"Payroll's shift, its stored hours a CASE whose ELSE the break drops, printing as a partial generation's guarded term does: the text audit admitted it by its shape alone, where the statement holds two partial generations and the text three guarded terms (rotating 0x9add1c84, case 312)",
					since: "2026-11-26"
				}
			],
			kills: [
				{
					file: "test/support/oracle/verify/sql.ts",
					original:
						"\t\t\t\t\t\tif (!top.elseSeen && !(guardedTerm && this.admitsGuardedTerm())) {\n",
					replacement: "\t\t\t\t\t\tif (!top.elseSeen && !guardedTerm) {\n",
					why: "A guarded term admitted by its shape alone: a stored generation's CASE whose ELSE went missing prints as a partial generation's does, the text audit admits it, and the property fails."
				},
				{
					file: "packages/engine/src/sql/lexer.ts",
					original: "\t\t\tout += text.slice(from, k) + String.fromCharCode(c - 32)",
					replacement: "\t\t\tout += text.slice(from, k) + String.fromCharCode(c - 31)",
					why: "Operator mutant (bound) at packages/engine/src/sql/lexer.ts:151 in toUpperAscii: `32` becomes `31`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)
