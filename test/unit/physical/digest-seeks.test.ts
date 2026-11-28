/**
 * A lookup that binds a text of no byte bound by equality seeks by the text's declared digest, and one that binds no
 * digest of it is refused (docs/limits.md "Keys and indexes"). Over a relation T(k, g, t) keyed by k, its text `t` of no byte
 * bound, which declares `h = Crypto.sha256(t)` where a case draws it, and a served read of T that states `t` equal to a
 * value in a drawn form (a literal or a parameter its match binds, an equality, with a value of t's type or of another
 * text type, or a membership its where states, an equality with another match's text, one variable another match's
 * text binds, a negation's literal or parameter, a parameter it binds the text to through a query of T that delivers
 * the text and its digest; and, by the digest's lineage, through queries that deliver the text and never its digest
 * (check/carry.ts): a parameter through one, a literal through one over a query that delivers both, one variable S's
 * text and two such queries bind, one variable S's text of another type and a chain of two such queries over one that
 * delivers both bind, and a negation's correlation of S's text with T's or with one such query's; and an equality with
 * the text of a match of S that binds no column of S from outside), binding T's key k besides where a case draws it:
 *
 * - a read that binds k reads one row by T's key, its text rechecked on it: it installs, and no index is created on T;
 * - otherwise, where T declares h, the read binds h wherever it binds t (check/checker.ts RuleCheck `#stateDigests`,
 *   a join by one variable split into a region equality by `#splitDigestedJoins`, a negation's correlation by
 *   `#relational`, each query between them carrying h beside t, and a joined match whose text the digest equality reads
 *   staying a join operand, never the semi-join's existence test, lower/optimize/existence joinedAbove), and the one
 *   index created on T holds h and never t,
 *   which its comment names as filtered beside it;
 * - where T declares no digest, the installation is refused as UnrepresentableKey (KeyFault `undigestedText`) naming t
 *   and no digest;
 * - S matched at its key by a parameter is read first, at that key, and T at S's text (lower/optimize/existence
 *   keyedOutside, lower/shapes/region chainOrder), never T whole with S tested at its key and T's text for each row;
 *   a match of S that binds none of its columns from outside drives where T declares h and T's key stays free, S read
 *   whole and T sought by its digest at each row of S (`joinedAbove`); where T is read first, its key bound or no
 *   digest of t declared, S is probed by its own text u, of no byte bound and no digest, and refused naming u.
 *
 * Oracle: the rule restated: no B-tree entry holds a text of no byte bound, a digest of 32 bytes is one any entry holds,
 * and a read by a key reads one row. Kept: the shapes of the consumer reads refused at 710c2d1d3, pantry's law probes
 * of a branch rule's target and the ledger's three reads of a test part's submission mode, and pantry's Head negation.
 * test/pg/reads/digest-seeks.test.ts holds the forms' rows to the undigested model on PostgreSQL.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str } from "effect"
import { refused, refusedKeys, succeeded } from "#test/support/assert.ts"
import {
	type DigestCase,
	digestCaseGen,
	type Form,
	installDigestCase
} from "#test/unit/physical/digest-seeks.fixtures.ts"

type DigestFeature = Form | "sought by its digest" | "refused undigested" | "read by its key"

/** Where a created index's comment ends with the keys it leaves out (core/identity.ts accessIndex). */
const filteredTail = " filtered beside it, not indexed: no byte bound fits the entry"

/** A read that binds a text of no byte bound by equality seeks by the text's declared digest and rechecks the text, a read by a key reads one row, and a read that binds no digest of the text is refused naming it. Its budget is the runner's: a new property, with no suite before it to carry a count from. */
export const aLookupThatBindsATextOfNoByteBoundByEqualitySeeksByItsDeclaredDigestAndOneThatBindsNoDigestOfItIsRefused =
	property.explore(digestCaseGen, {
		needs: {},
		situations: [
			"a literal",
			"a parameter",
			"an equality",
			"an equality of another text type",
			"a membership",
			"a joined text",
			"a shared variable",
			"a negated literal",
			"a negated parameter",
			"an imported text",
			"a carried parameter",
			"a carried literal",
			"a carried join",
			"a carried join of another text type",
			"a correlated negation",
			"a carried negation",
			"a joined text of a whole match",
			"sought by its digest",
			"refused undigested",
			"read by its key"
		] satisfies ReadonlyArray<Reached<DigestFeature>>,
		check: (_, c: Case<DigestFeature>) => (s: DigestCase) =>
			Effect.sync(() => {
				const installed = installDigestCase(s)
				if (s.form === "a joined text of a whole match" && (s.keyed || !s.digest)) {
					const keys = refusedKeys(refused(installed, "UnrepresentableKey"))
					assert.ok(
						Arr.some(
							keys,
							(k) =>
								k.fault.kind === "undigestedText" &&
								k.fault.field === "u" &&
								k.fault.digest === undefined
						),
						`S, read at T's row, is probed by its text u, of no byte bound and no digest, and refused naming u (${Arr.join(
							Arr.map(keys, (k) => k.fault.kind),
							", "
						)})`
					)
					c.note("refused undigested")
					return
				}
				if (!s.keyed && !s.digest) {
					const keys = refusedKeys(refused(installed, "UnrepresentableKey"))
					assert.ok(
						Arr.some(
							keys,
							(k) =>
								k.fault.kind === "undigestedText" &&
								k.fault.field === "t" &&
								k.fault.digest === undefined
						),
						`the read of T by its text t, of no byte bound and no digest, is refused naming t (${Arr.join(
							Arr.map(keys, (k) => k.fault.kind),
							", "
						)})`
					)
					c.note("refused undigested")
					return
				}
				const installation = succeeded(installed, "the case's installation")
				const created = Arr.filter(
					installation.indexes,
					(x) => x.relation === "T" && x.index.kind === "created"
				)
				if (s.keyed) {
					assert.equal(
						created.length,
						0,
						"a read by T's key reads one row through the key's own index"
					)
					c.note("read by its key")
					return
				}
				const [index, ...others] = created
				assert.ok(index !== undefined && others.length === 0, "one index created for the read of T")
				const held = Arr.map(index.keys, (k) => (k.column.kind === "field" ? k.column.field : ""))
				assert.ok(Arr.contains(held, "h"), `the index holds t's digest h (${Arr.join(held, ", ")})`)
				assert.ok(!Arr.contains(held, "t"), `the index never holds t (${Arr.join(held, ", ")})`)
				const [comment] = Arr.flatMap(installation.statements, (st) =>
					st.kind === "comment" && st.on.kind === "INDEX" && st.on.name.name === index.index.name
						? [st.text]
						: []
				)
				assert.ok(
					comment !== undefined && Str.endsWith(`, t${filteredTail}`)(comment),
					`the index's comment names t as filtered beside it (${comment ?? "none"})`
				)
				c.noteAll([s.form, "sought by its digest"])
			}),
		oracle: {
			kind: "specification",
			name: "README's lookup rule: no B-tree entry holds a text of no byte bound; a lookup binding one by equality seeks by its declared 32-byte digest, reads one row by a key, or is refused"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/physical/digest-seeks.test.ts#aLookupThatBindsATextOfNoByteBoundByEqualitySeeksByItsDeclaredDigestAndOneThatBindsNoDigestOfItIsRefused:-:d.0"
				),
				reason:
					"pantry's law probes of a branch rule's target (laws BranchResolution in ResolvedBranchRule and ResolvedBranchRule in ForwardBranchRule, qti-pie 5fab9435): Attribute(package, kind, name, start, value) probed by a Named identifier, a text of another type, joined to the target branchResolutionRows delivers through namingBranchRuleRows from attributeValues, which alone delivers valueDigest; refused undigestedText at 710c2d1d3",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/unit/physical/digest-seeks.test.ts#aLookupThatBindsATextOfNoByteBoundByEqualitySeeksByItsDeclaredDigestAndOneThatBindsNoDigestOfItIsRefused:-:b.0"
				),
				reason:
					'the ledger\'s result_suite reads answerTestItem, deliveredTestsOf and takeGuarded (qti-pie 5fab9435, member-controls.ts): TestPart matched at submission "individual", the mode testPartRows delivers from attributeValues without its digest, which Attribute(kind, name, package, path, value), (kind, name, package, value) and (kind, name, value) read by; refused undigestedText at 710c2d1d3',
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/unit/physical/digest-seeks.test.ts#aLookupThatBindsATextOfNoByteBoundByEqualitySeeksByItsDeclaredDigestAndOneThatBindsNoDigestOfItIsRefused:-:f.0"
				),
				reason:
					"pantry's Head (lom.ts): a lesson's package no package of the lesson claims, r.not(lessonClaims, { catalog, earlier, entry }), its catalog and entry correlated with the lesson's, texts lessonClaims delivers from Node.stringValue without stringValueDigest",
				since: "2026-11-24"
			},
			{
				token: ReplayToken(
					"test/unit/physical/digest-seeks.test.ts#aLookupThatBindsATextOfNoByteBoundByEqualitySeeksByItsDeclaredDigestAndOneThatBindsNoDigestOfItIsRefused:-:5.0"
				),
				reason:
					"S's text equated to T's by a where, T declaring h: since 83df0e6352 R02 counts the class's binders, so S became an existence test and the digest equality h = sha256(u) was read at T's own text, h = sha256(t), seeking by no digest: refused undigestedText on the merged tree (floor stream 0x126db407, case 4)",
				since: "2026-11-27"
			},
			{
				token: ReplayToken(
					"test/unit/physical/digest-seeks.test.ts#aLookupThatBindsATextOfNoByteBoundByEqualitySeeksByItsDeclaredDigestAndOneThatBindsNoDigestOfItIsRefused:-:6.0"
				),
				reason:
					"S's text and T's one variable, split into a region equality (#splitDigestedJoins): the same semi-join, its digest equality read at T's own text, refused undigestedText on the merged tree",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/existence/index.ts",
				original: "\t\t\t\t\t!keyedOutside(physical, node, o) &&\n",
				replacement: "",
				why: "A match the read's parameter binds at its key is an existence test again: S at s = $1 leaves the region for a semi-join, so T is read whole and S probed at its key and T's text for each row, the read binds t nowhere, and the installation refuses nothing though T declares no digest (the joined text and the shared variable)."
			},
			{
				file: "packages/engine/src/lower/optimize/existence/index.ts",
				original:
					"\t\tif (more.length === 0 && keeping.length === 1 && !heldOutside(node, only)) {\n",
				replacement: "\t\tif (more.length === 0 && keeping.length === 1) {\n",
				why: "A lone existence-only match is taken before its key is read: S at s = $1 relates T's text to no variable another match binds, so its removal keeps every restriction the region states and it becomes a semi-join, T read whole and refused nothing though T declares no digest."
			},
			{
				file: "packages/engine/src/lower/shapes/region/index.ts",
				original:
					"\t\treturn t === 0 ? 0 : once(p.placed.occurrence.source) ? 1 : t === 1 ? 2 : 3\n",
				replacement:
					"\t\treturn t === 0 ? 3 : once(p.placed.occurrence.source) ? 1 : t === 1 ? 2 : 0\n",
				why: "The chain leads with an occurrence a join alone binds, before the one a key lookup binds from parameters: T leads, read whole, and S follows at its key and T's text, so the read binds t nowhere and the installation refuses nothing though T declares no digest (the joined text and the shared variable)."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					'\t\t\t\t\t"in",\n\t\t\t\t\t[this.#slotExpr(slot), ...values.map((v) => this.cx.textDigest(v, loc))],\n',
				replacement: '\t\t\t\t\t"or",\n\t\t\t\t\tvalues.map((v) => eq(slot, v)),\n',
				why: "A membership's digest is a disjunction of equalities again, which binds no column: the read binds t by its membership alone, so the installation refuses it undigestedText though T declares h (a membership)."
			},
			{
				file: "packages/engine/src/physical/access/catalog.ts",
				original: '\treturn { kind: carrier === "text" ? "text" : "scalar", column, holds }\n',
				replacement:
					'\treturn field.desc.kind === "text" ? { kind: "search", column } : { kind: carrier === "text" ? "text" : "scalar", column, holds }\n',
				why: "The binding reads a declared text as no B-tree's column, as it read a text of no byte bound: a read binding t by equality alone asks nothing, so the installation refuses nothing, and T is scanned whole at every call though T declares no digest."
			},
			{
				file: "packages/engine/src/lower/optimize/existence/index.ts",
				original: "\t\t\t(o) => !cx.cells.lateral(o.source) && !joinedAbove(cx, cell, node, o)\n",
				replacement: "\t\t\t(o) => !cx.cells.lateral(o.source)\n",
				why: "A match whose text a digest equality joins to T's is an existence test again: the semi-join takes S out of the region and the equality reads T's own text, h = sha256(t), so T is read whole and S probed at its own text u, of no byte bound and no digest, for each row: refused undigestedText naming u, though T declares h and S read whole first seeks T by it (the joined text of a whole match)."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\tthis.#filters = [...this.#filters, ...owed]",
				replacement: "\t\tthis.#filters = [...this.#filters]",
				why: "The digest equalities the rule's filters owe are dropped: a read that states t equal to a parameter, a term or a list in its where binds t alone, so its index filters t beside the columns it holds, and the installation refuses it though T declares h."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					"\t\t\t\tif (digest === undefined || constants.some((d) => d.column === digest)) {",
				replacement: "\t\t\t\tif (digest === undefined || true) {",
				why: "A literal or a parameter a match fixes t by fixes no digest: the read binds t alone and is refused though T declares h."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original: "\t\tthis.#splitDigestedJoins()\n",
				replacement: "",
				why: "A join by one variable on a digested text states no digest: the variable's column is the one value at either match, so `h = sha256(x)` cannot be read from the other match, and the read binds t alone and is refused though T declares h."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					'\t\tif ((source.kind !== "query" && source.kind !== "step") || !isNonEmpty(equated)) {',
				replacement: "\t\tif (true) {",
				why: "No query carries the digest of the text it copies (check/carry.ts): a read that binds T's text through a query that delivers it without its digest binds the text alone, its parameter, literal, join or negation stating no digest, and is refused though T declares h."
			},
			{
				file: "packages/engine/src/check/carry.ts",
				original: "\tconst carried = carry(source.query, [text], digests, memo)",
				replacement:
					"\tconst carried = { query: source.query, digests: new Map<string, string>() }",
				why: "A query carries the digest of a text it copies only from a stored relation, never through a query it matches: a read of T's text through two such queries binds the text alone and is refused though T declares h."
			},
			{
				file: "packages/engine/src/check/checker.ts",
				original:
					'\t\t\tconst digest = p.kind === "correlated" ? digests.get(p.column) : undefined',
				replacement: "\t\t\tconst digest = undefined",
				why: "A negation that correlates T's text with a column of the rule's region states no digest: its negated read binds T's text alone, by the correlation, and is refused though T declares h."
			},
			{
				file: "packages/engine/src/ir/law.ts",
				original: '\t\t\tw.desc.fn !== "sha256" ||',
				replacement: '\t\t\t(w.desc.fn !== "sha256" && w.desc.fn !== "lowerAscii") ||',
				why: "A generation of the text that is no digest, T's l = Text.lowerAscii(t), recognized as its digest: the read equates l with the value's SHA-256, a text with a digest, and seeks by no digest, where T declares h."
			},
			{
				file: "packages/engine/src/physical/ddl/context.ts",
				original: "\t\t\t\tdigests: digestsOf(stored),",
				replacement: "\t\t\t\tdigests: new Map(),",
				why: "A stored relation's index target declares no digest (physical/ddl/context.ts BuiltTarget `digests`), as a lookup read its relation's digests off a model that held no laws of it did: a read that binds T's text by equality and seeks by h, its declared digest, is refused as undigested."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original:
					"\t\t\t\t\trefusedUndigested(b, r, stated.label, table.target, stated, keyed(r.relation))",
				replacement: "\t\t\t\t\tfalse",
				why: "A read that binds a text of no byte bound by equality and no digest of it is admitted: its index filters the text beside the columns it holds, reading every row they find."
			}
		]
	})
