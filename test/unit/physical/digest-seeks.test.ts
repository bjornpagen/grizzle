/**
 * A lookup that binds a text of no byte bound by equality seeks by the text's declared digest, and one that binds no
 * digest of it is refused (README "Keys and indexes"). Over a relation T(k, g, t) keyed by k, its text `t` of no byte
 * bound, which declares `h = Crypto.sha256(t)` where a case draws it, and a served read of T that states `t` equal to a
 * value in a drawn form (a literal or a parameter its match binds, an equality, with a value of t's type or of another
 * text type, or a membership its where states, an
 * equality with another match's text, one variable another match's text binds, a negation's literal or parameter, a
 * parameter it binds the text to through a query of T that delivers the text and its digest), binding T's key k besides
 * where a case draws it:
 *
 * - a read that binds k reads one row by T's key, its text rechecked on it: it installs, and no index is created on T;
 * - otherwise, where T declares h, the read binds h wherever it binds t (check/checker.ts RuleCheck `#stateDigests`,
 *   a join by one variable split into a filter's equality by `#splitDigestedJoins`), and the one index created on T holds
 *   h and never t, which its comment names as filtered beside it;
 * - where T declares no digest, the installation is refused as UnrepresentableKey (KeyFault `undigestedText`) naming t
 *   and no digest.
 *
 * Oracle: the rule restated: no B-tree entry holds a text of no byte bound, a digest of 32 bytes is one any entry holds,
 * and a read by a key reads one row.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
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
			"sought by its digest",
			"refused undigested",
			"read by its key"
		] satisfies ReadonlyArray<Reached<DigestFeature>>,
		check: (_, c: Case<DigestFeature>) => (s: DigestCase) =>
			Effect.sync(() => {
				const installed = installDigestCase(s)
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
		kept: [],
		kills: [
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
				original: "\t\tthis.#filters = [...this.#filters, ...this.#splitDigestedJoins(loc)]",
				replacement: "\t\tthis.#filters = [...this.#filters]",
				why: "A join by one variable on a digested text states no digest: the variable's column is the one value at either match, so `h = sha256(x)` cannot be read from the other match, and the read binds t alone and is refused though T declares h."
			},
			{
				file: "packages/engine/src/ir/law.ts",
				original: '\t\t\tw.desc.fn !== "sha256" ||',
				replacement: '\t\t\t(w.desc.fn !== "sha256" && w.desc.fn !== "lowerAscii") ||',
				why: "A generation of the text that is no digest, T's l = Text.lowerAscii(t), recognized as its digest: the read equates l with the value's SHA-256, a text with a digest, and seeks by no digest, where T declares h."
			},
			{
				file: "packages/engine/src/physical/indexes/engine.ts",
				original: "\t\t\t\t\trefusedUndigested(b, r, label, o, keys, roles, keyed(r.relation))",
				replacement: "\t\t\t\t\tfalse",
				why: "A read that binds a text of no byte bound by equality and no digest of it is admitted: its index filters the text beside the columns it holds, reading every row they find."
			}
		]
	})
