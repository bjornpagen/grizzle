/**
 * The logical analysis's claims hold on the facts.
 *
 * Every generated query is annotated with its schema's declared keys and containments, under a drawn execution context
 * and drawn containment contexts, and evaluated by the reference evaluator, every evaluation recorded: a correlated
 * node once per outer tuple it was evaluated under. On every relation a node denoted, its claimed cardinality bounds its
 * rows (at most one row unless `many`, exactly one when `one`) and no two rows agree on a claimed logical key; and for
 * every attachment, the children each parent row receives
 * respect the child's claims relative to the parent and the delivered type: at most one for an Option, exactly one for
 * a bare child. A read inside a transaction may see facts that break a containment only checked at commit, so there
 * the cases drop a target relation's facts and leave its sources orphaned: evidence the context does not admit must
 * prove nothing. An unsound claim here would let get, an Option attachment or a dropped DISTINCT change an answer.
 *
 * - Soundness (keys and cardinality bounds, under every context, delivered types rooted at attachments, bare children
 *   along declared containments and filters over one fact): every claim holds on the reference evaluator's facts, and
 *   every key proof the analysis emits passes the key kernel (test/support/keys/kernel.ts), which reads each rule's
 *   side condition off the DAG alone, and every name the analysis gives a fixed column is one of its node's values: a
 *   literal, a parameter, or a column the node reads from outside it (ir/dag.ts nodeScopes, read apart from the
 *   analysis). Oracle: the reference evaluator, a second implementation; the kernel; and the scope, universal. A
 *   column a node binds holds one value per row, not per evaluation, so it is no value the kernel reads off a
 *   derivation (a kept case) and no name of a fixed column (a kept case). The
 *   bare children's schemas may key a relation by a span key, so a containment into one is a span coverage (a PERIOD
 *   foreign key, coverage in the analysis's evidence), and the proving shapes may narrow its source facts inside their
 *   target's spans, where a bare child would find none (a kept case).
 * - Idempotence (generated cases, and the proving shapes' bare children): annotating an annotated DAG states what the
 *   first annotation did, node for node. Oracle: universal.
 *
 * Features: each claim checked (EvidenceFeature), each execution and containment context, an orphaned containment and
 * a span coverage's fact covered apart from its target's spans; each claim and delivered type for idempotence.
 */
import { ReplayToken } from "@bjornpagen/testing/property"
import { defaultGenConfig, soundnessGenConfig } from "#test/support/oracle/gen/case.ts"
import {
	attachmentRooted,
	holdsOn,
	idempotentOn,
	narrowedProvingCases,
	orphanedCases,
	provingCases,
	sketchedCases
} from "#test/unit/analysis/logical/evidence.fixtures.ts"

/** The logical analysis's claims hold on the facts keys and cardinality bounds over generated cases. */
export const theLogicalAnalysissClaimsHoldOnTheFactsKeysAndCardinalityBoundsOverGeneratedCases =
	holdsOn(sketchedCases(defaultGenConfig), {
		situations: [
			"claimed at most one row",
			"claimed one row",
			"delivered option",
			"execution transaction"
		],
		aims: [],
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/expr.ts",
				original: `\t\t\treturn inRange(literal.value, range) ? undefined : \`\${literal.value} lies outside \${carrier}\``,
				replacement: `\t\t\treturn inRange(literal.value, range) ? \`\${literal.value} lies outside \${carrier}\` : undefined`,
				why: `Operator mutant (arm-swap) at packages/engine/src/ir/expr.ts:880 in literalProblem: \`inRange(literal.value, range) ? undefined : \`\${literal.value} lies outside \${car\` becomes \`inRange(literal.value, range) ? \`\${literal.value} lies outside \${carrier}\` : und\`; the property fails (lane CATCH, grizzle 0baff5d6).`
			},
			{
				file: "packages/engine/src/ir/expr.ts",
				original: `\t\t\treturn inRange(literal.value, range) ? undefined : \`\${literal.value} lies outside \${carrier}\``,
				replacement: `\t\t\treturn inRange(literal.value, range) ? \`\${literal.value} lies outside \${carrier}\` : undefined`,
				why: `Operator mutant (arm-swap) at packages/engine/src/ir/expr.ts:880 in literalProblem: \`inRange(literal.value, range) ? undefined : \`\${literal.value} lies outside \${car\` becomes \`inRange(literal.value, range) ? \`\${literal.value} lies outside \${carrier}\` : und\`; the property fails (lane CATCH, grizzle 0baff5d6).`
			}
		]
	})

/** The logical analysis's claims hold on the facts keys, cardinality and determinism over cases with lateral sources, shared nodes, windows and approximate searches. */
export const theLogicalAnalysissClaimsHoldOnTheFactsKeysCardinalityAndDeterminismOverCasesWithLateralSourcesSharedNodesWindowsAndApproximateSearches =
	holdsOn(sketchedCases(soundnessGenConfig), {
		situations: [
			"claimed at most one row",
			"a correlated MatchRegion evaluated per outer tuple",
			"a correlated Take evaluated per outer tuple",
			"an approximate search"
		],
		aims: [],
		kept: [
			{
				token: ReplayToken(
					"test/unit/analysis/logical/evidence.test.ts#theLogicalAnalysissClaimsHoldOnTheFactsKeysCardinalityAndDeterminismOverCasesWithLateralSourcesSharedNodesWindowsAndApproximateSearches:-:2.2.0.1.0.1.a.0.0.1.1.0.0.0.0.0.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.6.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.6.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.4.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.c.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.2"
				),
				reason: "a correlated take over one fact was claimed exactly one row and had none",
				since: "2026-10-29"
			},
			{
				token: ReplayToken(
					"test/unit/analysis/logical/evidence.test.ts#theLogicalAnalysissClaimsHoldOnTheFactsKeysCardinalityAndDeterminismOverCasesWithLateralSourcesSharedNodesWindowsAndApproximateSearches:-:1.0.0.3.1.0.0.0.0.1.0.0.1.0.0.0.0.1.0.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.9.6.0.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.2.8.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.9.l.3.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.5.0.0.0.5.0.0.0.5.0.0.0.0.0.0.0.0.0.0.0.0.s3d.0.0.0.0.0.6bk.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.f.0.0.0.0.0.g.0.0.0.0.0.f.f.0.0.0.0.0.0.0.0.0.0.f.0.0.0.0.0.2.0.0.0.0.0.0.0.0.g.h.0.0.0.0.0.0.0.2.1.0.0.0.2.1.1.1.2.0.0.0.1"
				),
				reason:
					"the key kernel refused a lateral equality, reading a column an inner region binds as the value of a column carried out of it",
				since: "2026-11-14"
			},
			{
				token: ReplayToken(
					"test/unit/analysis/logical/evidence.test.ts#theLogicalAnalysissClaimsHoldOnTheFactsKeysCardinalityAndDeterminismOverCasesWithLateralSourcesSharedNodesWindowsAndApproximateSearches:-:1.0.1.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.8.2.1.e.2.6.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.9.1.8.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.1.i.9.2.6.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.f.h.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.f.0.0.0.0.0.0.2.2"
				),
				reason:
					"a region named a fixed column by a column of its own occurrence source, carried from a lateral source",
				since: "2026-11-14"
			}
		],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original:
					'\tname.kind !== "outer" || props.outer.get(name.node)?.has(name.column) === true ? name : undefined',
				replacement: '\tname.kind !== "outer" || props.outer.size >= 0 ? name : undefined',
				why: "A node names a fixed column by a column it binds (logical/props.ts nameAt reads no scope): a region carries a lateral source's name of an earlier source's column as a value of its own; the soundness property fails on boundHandleNamed."
			}
		]
	})

/** The logical analysis's claims hold on the facts delivered types over cases rooted at attachments, under every context. */
export const theLogicalAnalysissClaimsHoldOnTheFactsDeliveredTypesOverCasesRootedAtAttachmentsUnderEveryContext =
	holdsOn(sketchedCases(attachmentRooted), {
		situations: [
			"delivered option",
			"committedSnapshot containment",
			"an orphaned containment inside a transaction"
		],
		aims: [["an orphaned containment inside a transaction", orphanedCases(attachmentRooted)]],
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/expr.ts",
				original: `\t\t\treturn inRange(literal.value, range) ? undefined : \`\${literal.value} lies outside \${carrier}\``,
				replacement: `\t\t\treturn inRange(literal.value, range) ? \`\${literal.value} lies outside \${carrier}\` : undefined`,
				why: `Operator mutant (arm-swap) at packages/engine/src/ir/expr.ts:880 in literalProblem: \`inRange(literal.value, range) ? undefined : \`\${literal.value} lies outside \${car\` becomes \`inRange(literal.value, range) ? \`\${literal.value} lies outside \${carrier}\` : und\`; the property fails (lane CATCH, grizzle 0baff5d6).`
			},
			{
				file: "packages/engine/src/ir/expr.ts",
				original: `\t\t\treturn inRange(literal.value, range) ? undefined : \`\${literal.value} lies outside \${carrier}\``,
				replacement: `\t\t\treturn inRange(literal.value, range) ? \`\${literal.value} lies outside \${carrier}\` : undefined`,
				why: `Operator mutant (arm-swap) at packages/engine/src/ir/expr.ts:880 in literalProblem: \`inRange(literal.value, range) ? undefined : \`\${literal.value} lies outside \${car\` becomes \`inRange(literal.value, range) ? \`\${literal.value} lies outside \${carrier}\` : und\`; the property fails (lane CATCH, grizzle 0baff5d6).`
			}
		]
	})

/** The logical analysis's claims hold on the facts bare children along declared containments and filters over one fact. */
export const theLogicalAnalysissClaimsHoldOnTheFactsBareChildrenAlongDeclaredContainmentsAndFiltersOverOneFact =
	holdsOn(provingCases, {
		situations: [
			"delivered one",
			"a filter over one row",
			"an orphaned containment inside a transaction",
			"a span coverage's fact covered apart from its target's spans"
		],
		aims: [["a span coverage's fact covered apart from its target's spans", narrowedProvingCases]],
		kept: [
			{
				token: ReplayToken(
					"test/unit/analysis/logical/evidence.test.ts#theLogicalAnalysissClaimsHoldOnTheFactsBareChildrenAlongDeclaredContainmentsAndFiltersOverOneFact:-:1.6.0.2.1.0.0.0.0.0.0.0.0.3.0.0.0.3.0.0.0.1.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.3.3.h.1.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.f.0.0.0.1.0.4.0.4.0.2.0.0.0.3.0.0.0.0.5.6.0.0.0.0.0.0.0.0.0.0.7.0.h.f.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.h.0.0.2.0.0.0.0.0.0.f.0.1.0.0.0.0.0.2"
				),
				reason:
					"a parameter compared with a sum was drawn as Infinity, which its numeric(161, 40) cannot hold",
				since: "2026-11-08"
			},
			{
				token: ReplayToken(
					"test/unit/analysis/logical/evidence.test.ts#theLogicalAnalysissClaimsHoldOnTheFactsBareChildrenAlongDeclaredContainmentsAndFiltersOverOneFact:-:1.d.0.2.2.0.0.0.0.0.0.0.0.1.2.0.0.0.0.0.0.1.0.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.d.2.6.9.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.h.d.2.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.8.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.f.0.0.0.0.1.pa8.0.0.2"
				),
				reason:
					"a span coverage typed a bare child, and a parent covered apart from its target's span had none",
				since: "2026-11-14"
			},
			{
				token: ReplayToken(
					"test/unit/analysis/logical/evidence.test.ts#theLogicalAnalysissClaimsHoldOnTheFactsBareChildrenAlongDeclaredContainmentsAndFiltersOverOneFact:-:1.0.1.2.4.1.7.0.0.0.0.b.0.1.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0"
				),
				reason:
					"a closed payload of double precision holding Open 0 and Held -0, one value under PostgreSQL's equality, claimed a key",
				since: "2026-11-19"
			}
		],
		kills: [
			{
				file: "packages/engine/src/ir/expr.ts",
				original:
					'\t\t\tliteral.kind === "floatSpecial" && literal.value === "-0" ? floatLiteral(0) : literal',
				replacement: "\t\t\tliteral",
				why: "A literal's equality key tells -0 from +0, so a closed payload of both zeros claims a key PostgreSQL's equality breaks (ir/expr.ts nativeEqualityKey); the kept case fails."
			},
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\t\t...rest,\n\t\t\t\texactlyOne: false,",
				replacement: '\t\t\t\t...rest,\n\t\t\t\texactlyOne: input.card === "one",',
				why: "A filter over an input of exactly one row claims exactly one, though it may drop it (logical/props.ts); the soundness property fails."
			},
			{
				file: "packages/engine/src/logical/attach.ts",
				original:
					"\t\tif (fact.coverage || fact.to.relation !== scan.relation || fact.to.selection.length > 0) {",
				replacement:
					"\t\tif (fact.to.relation !== scan.relation || fact.to.selection.length > 0) {",
				why: "A span coverage proves a bare child (logical/attach.ts containmentOne), which a parent covered apart from its target's span refutes; the bare-children property fails on spanCoverageNarrowed."
			}
		]
	})

/** The logical analysis is idempotent: annotating twice states what annotating once states, over cases rooted at plain rows, attachments and unions. */
export const theLogicalAnalysisIsIdempotentAnnotatingTwiceStatesWhatAnnotatingOnceStatesOverCasesRootedAtPlainRowsAttachmentsAndUnions =
	idempotentOn(
		sketchedCases({
			...defaultGenConfig,
			query: {
				...defaultGenConfig.query,
				roots: {
					...defaultGenConfig.query.roots,
					plain: 1,
					attach: 2,
					hetero: 1
				}
			}
		}),
		{
			situations: [
				"claimed at most one row",
				"claimed one row",
				"claimed a logical key",
				"delivered array",
				"delivered option"
			],
			kept: [],
			kills: [
				{
					file: "packages/engine/src/logical/annotate.ts",
					original: "\t\t: relNode(node.id, { ...body, meta: claims })",
					replacement:
						"\t\t: relNode(node.id, {\n\t\t\t\t...body,\n\t\t\t\tmeta: { ...claims, logicalKeys: [...node.meta.logicalKeys, ...claims.logicalKeys] }\n\t\t\t})",
					why: "A node's claimed keys gather its earlier claims beside the new ones (logical/annotate.ts rebuilt); the idempotence property fails."
				}
			]
		}
	)

/** The logical analysis is idempotent: annotating twice states what annotating once states, over the proving shapes. */
export const theLogicalAnalysisIsIdempotentAnnotatingTwiceStatesWhatAnnotatingOnceStatesOverTheProvingShapes =
	idempotentOn(provingCases, {
		situations: ["delivered one"],
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/partition.ts",
				original: "openedAs[block] = openedIn.length",
				replacement: "{}",
				why: "Operator mutant 7cb605f240 at packages/text/src/regex/partition.ts:86 in partitionOf: `openedAs[block] = openedIn.length` becomes `{}`; the property fails (the census, lane TESTPOLICY2)."
			}
		]
	})
