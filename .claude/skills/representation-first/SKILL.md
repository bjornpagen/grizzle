---
name: representation-first
description: Load before refactoring or designing any grizzle code, and whenever you reach for a new branch, flag, guard, optional field, sentinel value, or re-validation. Change the representation so the case stops being special or stops being expressible, and make invalid states unrepresentable.
---

# Representation first

The biggest lever in programming is the data representation, not the control flow. When a new case shows up, you can
patch the trace of the computation with another branch, flag, or guard, and complexity piles up in the control flow.
Or you can change the data, types and invariants so the case stops being special, or stops being expressible at all.
Do the second.

## Applying it in grizzle

**The moves, in order of preference:**

1. **Make the state impossible.**
   - Replace clusters of booleans, optionals and nullable-ish fields with a discriminated union whose variants carry
     exactly their legal fields.
   - No `undefined` meaning "absent" next to a flag meaning "present". No `""` or `-1` sentinels. No `kind` string
     plus fields that only some kinds use.
2. **Parse at the boundary; never re-validate inside.**
   - External input (Descriptions from JavaScript, snapshot and meta JSON, rows from PostgreSQL, CLI arguments, the
     config, environment variables) is decoded once, with Effect Schema or a parser, into a type that carries the
     proof.
   - Downstream code takes the parsed type and never checks again. A check repeated deep in the compiler is a sign the
     type is too weak.
3. **No fallbacks.** A fallback is usually a representation that admits a state production never has, plus a branch
   that papers over it. That covers `x ?? default`, `x || default`, an optional parameter or field with a default, a
   `catch` that substitutes a value, and "if absent, use X".
   - **When production always supplies the value, make it required** and delete the default. Tests build the real
     thing, through the production path.
   - **When the absence is a real case, make it a variant** whose handling is exhaustive, not a default that silently
     picks one side.
   - **When a failure can happen, make it a typed error,** never a substituted value.
   - **What stays:** a genuine domain absence, such as an accumulator's `map.get(k) ?? 0` or an optional public option
     whose default is documented in the README. Parse that once at the public boundary into a required internal
     field.
4. **Brand what is distinct.** Identifiers, names, fingerprints, digests, SQL fragments and law ids get an Effect
   `Brand.nominal` brand when mixing them up would be a bug. Brands are unchecked; no defensive validators.
5. **Exhaustive dispatch over tags.** A `switch` on a discriminant ends in a `never` check, so a new variant is a
   compile error everywhere it matters. Prefer a record of handlers keyed by tag, or a method on the variant, over
   scattered conditionals.
6. **Choose coordinates that delete special cases:** half-open ranges, a sentinel or empty element instead of "first
   and last are special", one uniform node shape instead of per-kind side tables.
7. **Reify hairy control flow as data:** a small table or IR plus an evaluator, which the compiler already does for
   queries, instead of nested branching.

**grizzle's rules still bind:**
- **Fully type-safe:** no casts except `as const`, no `any`, no non-null `!`, no overloads, no lying type predicates.
  The gate is `pnpm check`: the dev tools' oxlint preset and plugin, and superlint (`packages/devtools`).
- **The feasibility rule:** if TypeScript can't prove the invariant, don't fake it with a predicate, a conditional
  tower or a shadow type. Use the plainest representation TypeScript can check, and keep the runtime check at the
  one boundary that parses.
- **Heavy type-level programming lives only in the query layer** (joins, headings, evidence, params). Everywhere
  else, use ordinary discriminated unions, brands, readonly types and exhaustive switches. That is enough to make
  most invalid states unrepresentable without type-level computation.
- **Immutable by default:** frozen values are shared by reference, never defensively copied.
- **Correctness over performance** when in doubt.
- **Outputs stay byte-identical:** SQL, manifests, snapshots, fingerprints. A representation change is a refactor,
  not a behaviour change. Check with `scripts/dev/profile/compile.ts`'s dump.

**The limit (Brooks):** representation removes *accidental* complexity, not *essential* complexity. Don't force two
genuinely different cases into one representation; that only hides the branch in a flag. If the right representation
isn't visible yet, leave it. A refactor must be earned by the pattern the code already shows.

---

## Purpose

To document and ground one principle: the biggest lever in programming is the data representation, not the control
flow. Brooks, Pike, Raymond, and Torvalds have said this in almost the same words across fifty years, and type theory
explains why it works.

## Spiky points of view

1. **The data representation determines a program's complexity. The algorithm and the control flow are downstream of
   it.**
   - Four respected practitioners reached this independently across thirty-one years, and two of them cite Brooks by
     name.
   - When complexity grows, change the representation before you add to the control flow, because the representation
     is where the complexity actually lives.
2. **Most of the branches in typical code are not handling the problem. They are guarding against states a more
   precise representation would have made impossible.**
   - Three independent booleans (`loading`, `error`, `data`) admit eight states, of which only a few are valid. A
     four-case sum type admits exactly four.
   - Minsky: "make illegal states unrepresentable."
   - King: validation checks a condition and throws away what it learned, so every caller downstream must check again.
     Parsing returns a type that carries the proof, so the check happens once at the boundary.
   - Null is the proof by counterexample: it sits in every type at once, which is exactly why it forces a check on
     every use.
3. **Most special cases belong to the representation, not the problem. Change the representation and they are gone,
   not handled.**
   - **Dijkstra's half-open interval** makes length equal `b - a`, the empty range clean, and adjacent ranges
     gap-free.
   - **Homogeneous coordinates** make translation the same matrix multiply as rotation.
   - **A sentinel node** makes the first and last elements stop being special.
   - **The ceiling** is turning tangled control flow into data: an AST with a small evaluator. Greenspun's rule is the
     warning that a complex enough program grows a bad interpreter by accident if you don't build a good one on
     purpose.

## Insights

**The lineage**

- **Two ways to absorb a new case.** Patch the trace (a branch, flag, or guard) and complexity gathers in the control
  flow. Change the structure (data, types, invariants) and the case stops being special or expressible.
- **Brooks stated it; Pike made it operational.**
  - Brooks: "Show me your flowcharts and conceal your tables, and I shall continue to be mystified. Show me your
    tables, and I won't usually need your flowcharts; they'll be obvious." (*The Mythical Man-Month*, ch. 9, p. 102,
    under "Representation Is the Essence of Programming".)
  - Pike, Rule 5: "Data dominates. If you've chosen the right data structures and organized things well, the
    algorithms will almost always be self-evident." (See Brooks p. 102.)
- **It holds at the largest scale.** Torvalds: "Bad programmers worry about the code. Good programmers worry about
  data structures and their relationships." Git's content-addressed object model is an existence proof.
- **The convergence is the evidence:** Brooks (1975) → Pike (1989, citing Brooks) → Raymond (1997, "smart data
  structures and dumb code", citing Brooks) → Torvalds (2006, independent).

**Why precise types remove branches**

- **Illegal states are the hidden source of branching.** A sum type gives exactly the valid states, so the guards have
  nothing to guard.
- **Null is the mechanism, inverted.** The fix Hoare skipped, the disjoint union, is the sum type.
- **Validation discards proof; parsing keeps it** (King, "Parse, Don't Validate"). The information the branch tested
  for moves into the type.
- **A type signature is an enforced specification** (Wadler, "Theorems for Free!"; Reynolds' Abstraction Theorem).
  Well-typed clients cannot branch on a concrete representation.

**Techniques that remove branches**

- **A switch on a type tag is a polymorphism not yet named** (Fowler, "Replace Conditional with Polymorphism").
- **Absence and boundaries are representational choices:** Null Object (Woolf), sentinel nodes (CLRS §10.2).
- **Off-by-one is usually a coordinate error** (Dijkstra, EWD831).
- **Some special cases are pure coordinate artifacts** (homogeneous coordinates).
- **Greenspun's rule is the principle as a warning.**
- **The ceiling is to make control flow into data** (SICP ch. 4: "the evaluator ... is just another program").

**The limit**

- **Representation is globally cheap but locally expensive; control flow is the reverse.** That cost structure, not
  virtue, is why adding a branch is the common reflex and investing in representation is the experienced one.
- **It removes accidental complexity, not essential complexity** (Brooks, "No Silver Bullet"). Force two genuinely
  different cases into one representation and the branching just hides inside config flags. The right representation
  is usually only visible after the imperative version exposes the pattern.
