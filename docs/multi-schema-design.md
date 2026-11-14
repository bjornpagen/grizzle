# Multi-schema: one installation, several PostgreSQL schemas

**2026-11-14:** This design was built on main on 2026-11-08 (999facc6), so "Nothing here is built" no longer holds:
Decisions 1, 5, 6 and 8 stand as recommended (a level-name clash is `IdentifierCollision`), while README's "Levels"
section, which states what is true, departs from the others: the root's schema holds the installation's contract and
text domains, constants and grizzle's functions (Decision 2); a level reaches a relation below it only by a
containment of plain fields into a declared key, a rule over a query or a row check, and anything else is
`LevelRefused` (Decision 3); an `above` law is `refused.laws[0]` of a refusal whose `refused.kind` is `above`
(Decision 4); and `DbLayer.make` takes a login's served file (Decision 7). Since then a schema's relations are a list,
a role may write by an `insert` list (open question 6), and consumers take grizzle as a git submodule, not vendored
tarballs.

EduLLM's requirements for the grizzle session's MULTISCHEMA lane, read against main at 3cc8fbda. Each decision stands
alone: what is decided, the options, a worked example, and a recommendation. Nothing here is built.

## Words

- **Level**: one schema value in an extends chain. `Qti` is a level; `schema.extend(Qti, "Ledger", …)` is a level above
  it.
- **Root**: the lowest level of a chain, the one `schema(...)` built.
- **Installation**: what one configured schema installs in one database: every level of its chain, their roles and
  logins, and one migrations ledger.

## The need

EduLLM's QTI database holds two schemas in one PostgreSQL database, installed by one config:

- `qti`: qti-pie's `Qti` (pantry), with its role `Author` and login `AuthorApp` (`qti__author_app`), unchanged.
- `ledger`: EduLLM's `Ledger`, built on `Qti`. Its relations reference Qti's relations through containments the
  database enforces. Its login `ledger__app` has a role that reads Qti's tables whole, read only, and writes only
  Ledger's relations.

Pantry's commands open `AuthorApp` against this installation; the QTI app opens `ledger__app`.

What main refuses today:

- `schema.extend` keeps the base's name (`admitExtend` and `extend` in packages/engine/src/schema/schema.ts), and
  ownership refuses a level under any other name (`Owner.run`, schema/own.ts). So an extension installs inside `qti`,
  in `migrations/qti/`, and its logins are `qti__*`.
- The config refuses a login over a lower level (`otherVersion`, packages/grizzle/src/cli/config.ts), and
  `DbLayer.make` refuses one too (`startupCheck`, adapter/pool/registry.ts, through `servesSchema`,
  adapter/admission/snapshots.ts): the snapshot file records no level below its own, and only the test installer's
  registry serves a lower level.
- `login(...)` refuses a role over another level (`roleBase`, `roleTwice`, schema/world.ts). That rule stays
  (Decision 6).

## The running example

```ts
// pantry: unchanged
export const Qti = schema("Qti", { …, NodeKind, Package, Resource, … }, qtiLaws)
export const Author = role(Qti, "author", wholeEntriesOf(Qti), { write: writableNamesOf(Qti) })
export const AuthorApp = login(Qti, "author_app", [Author], { workload: [exportWork, importWork] })

// EduLLM: the ledger's names are illustrative
export const ClerkUser = str.regex("^user_[0-9A-Za-z]{1,64}$")
export const Sitting = relation("Sitting", { id: uuid, child: ClerkUser, package: uuid }, ["id"])
export const Served = relation(
	"Served",
	{ sitting: uuid, step: natural, resource: uuid, kind: closedId(NodeKind) },
	["sitting", "step"]
)
export const Ledger = schema.extend(Qti, "Ledger", { Sitting, Served, Answer, Grade }, [
	contained(on(Sitting, "package"), on(Package, "id")),
	contained(on(Served, "resource"), on(Resource, "node")),
	contained(on(Served, "sitting"), on(Sitting, "id"))
	// …
])
export const Child = role(
	Ledger,
	"child",
	{ ...wholeEntriesOf(Qti), Sitting: mySittings, Served: myServed, Answer: myAnswers, Grade: myGrades },
	{ write: ["Sitting", "Served", "Answer", "Grade"] }
)
export const LedgerApp = login(Ledger, "app", [Child], { workload: [childWork] })

export default defineConfig({
	schemas: [Ledger],
	logins: [AuthorApp, LedgerApp],
	migrations: "migrations",
	connection
})
```

## Decision 1: the builder

**Decided:** how a level above another is declared, and whether an extension may keep its base's name.

**Options:**

- **A.** `schema.extend(base, name, relations, statements)`. Every extension has its own name, alike to no level
  below it, and installs in its own PostgreSQL schema. The same-name extension is gone.
- **B.** The same signature, but a name equal to the base's keeps today's meaning: one PostgreSQL schema. That is two
  ways to extend.
- **C.** A separate builder for a named level beside today's `schema.extend`. Also two ways.

**Worked example (A):** `schema.extend(Qti, "Ledger", { Sitting, … }, [...])` installs `ledger.sitting`.
`schemaNameOf(Ledger)` is `"ledger"`, `schemaNameOf(Qti)` stays `"qti"`, `roleNameOf(LedgerApp)` is `"ledger__app"`,
`roleNameOf(AuthorApp)` stays `"qti__author_app"`. `schema.extend(Qti, "QTI", …)` and `schema.extend(Qti, "Qti", …)` are
refused when the schema is built, because `QTI` and `Qti` convert to `qti`: a typed refusal, say `SchemaRefused` with the
rule `levelNameTaken`, naming both levels. A chain of any length works: `schema.extend(Ledger, "Reports", …)` installs
`reports`.

**What changes:** derived relations can still be declared only in an extension, since their queries need the schema
value first, so every schema with a derived relation becomes two PostgreSQL schemas. README's
`Reporting = schema.extend(Usage, { ModelSpend }, [])` becomes `schema.extend(Usage, "Reporting", { ModelSpend }, [])`:
the materialized view `model_spend` moves to `reporting`, and `Analyst` and `UsageApi` become `reporting__analyst` and
`reporting__usage_api`. The type `Schema<Name, …, Base>` carries the extension's own name. grizzle's own tree mentions
`schema.extend(` 110 times in 59 files (tests, fixtures, benches, README, SKILL.md and doc comments); each call gains
a name. pantry has none.

**Recommendation: A.** It matches `role(base, name, …)` and `login(base, name, …)`, and it is the one way: a level's
name is where it lives.

## Decision 2: where each installed object lives

**Decided:** which PostgreSQL schema each object goes in once an installation has several.

**Options:**

- **A.** Each object goes in the schema of the level whose declaration needs it:
  - a level's tables, materialized views, rosters' domains and names constants, and the identity sequences of its
    tables, in its own schema;
  - a law's objects with the law's level: its trigger function and its constants. Its foreign key, CHECK, unique index
    and stored generated columns sit on the table they constrain, wherever PostgreSQL puts them;
  - a role's views, filter functions and probes in its role schema, `<level>__<role>`, and its policies on the tables it
    writes;
  - an object named by its definition alone (a contract's or a text pattern's domain, a closed relation's constant, a
    set's bits domain over the level's own roster): one copy in each level that uses it, so a level never depends on a
    definition only a higher level uses;
  - a level's `__refuse` and `__require_serializable` in its own schema; `__ledger` and `__snapshot_guard` once, in the
    root's schema (Decision 5).
- **B.** As A, but an object named by its definition is shared, placed at the lowest level that uses it. A lower level
  that stops using it then moves it up (`ALTER DOMAIN … SET SCHEMA`), and one a lower level starts using moves it down.

**Worked example (A):** `Sitting.child` is typed `ClerkUser`, so `ledger.__text_…` is created. `Served.kind` is a closed
id over Qti's roster `NodeKind`, so its column is typed `qti.node_kind`: a roster has one domain, at its level, and
its codes are that level's history. The containment of `Served.resource` into `Resource.node` is:

```sql
ALTER TABLE "ledger"."served" ADD CONSTRAINT "__served_fk_resource_…"
	FOREIGN KEY ("resource") REFERENCES "qti"."resource" ("node");
```

A Ledger containment into a selection of a Qti relation adds its stored generated columns and unique index to the Qti
table, which rewrites it in the migration that adds them.

**To verify while building:** a foreign key between two per-level copies of one contract's domain (`ledger.__domain_x`
referencing `qti.__domain_x`) must compile natively. PostgreSQL resolves a domain's equality through its base type, but
grizzle's own law checks should confirm it.

**Recommendation: A.** Each level's schema holds what its own declarations need, and B moves objects between schemas
whenever a level's use of a definition changes.

## Decision 3: what a level may state about relations below it

**Decided:** which statements at an upper level may name a lower level's relations.

**Options:**

- **A.** Any statement, except one that fills a lower relation's field or changes its mutability: no family, tree or
  fold over a lower relation, no containment whose copy rides a lower family's axis, no `mutable` of a lower relation.
  In general, every drawn, accumulated or copied field is filled by a law of its own relation's level. The refusal is
  typed, say `SchemaRefused` with the rule `fillsBelow`, naming the statement, the field and both levels.
- **B.** A lower relation may appear only as a containment's target, or be read by a rule over a query. Everything
  else about it is refused.
- **C.** Anything.

**Worked example:** pantry compiles `AuthorApp`'s writes over `Qti` alone; it never sees `Ledger`. Under C,
`schema.extend(Qti, "Ledger", …, [ordered(on(LedgerStep, …), fin(Package, "steps"))])` would make `Package.steps` a
field grizzle draws in EduLLM's installation, while Author still writes it as its caller's. Author's import would then
write a wrong count. Under A, that statement and `mutable(Package)` stated at Ledger are refused when `Ledger` is built.
README's Billing example, `contained(on(Post, "org"), on(Subscription, "org"))`, stays legal under A: a level above
constrains a lower level's rows without filling them. Under B it is refused.

**Recommendation: A.** It refuses exactly what would make a lower level's compiled writes depend on the levels above
it, and nothing else.

## Decision 4: what a lower level's Db reports when a law above refuses its write

**Decided:** the outcome when a Db over a lower level is refused by a law of a level it does not know. Under any
option of Decision 3 this happens: deleting a row a level above references breaks a foreign key.

**Options:**

- **A.** A new law kind, `{ kind: "above", level, law }`. `level` is the declared name of the level that states the
  law, and `law` is the rule as `lawsOf(level)` lists it. It appears in `refused.laws` like any other law. The lower
  Db reads it from the snapshot, which records the level and the outcome form of each law stated at one level whose
  constraint or trigger sits on a lower level's table. The lower Db judges only its own levels' laws on the host, so a
  CHECK refusal on a table that also carries a check from above is reported `first`. The witness follows today's rules:
  a key the writer submitted, or `unreported`.
- **B.** The same wrapper, but naming the level only, without the law.
- **C.** Name the upper law plainly, as if it were the Db's own.

**Worked example (A):** pantry's import deletes a `Package` that a `Sitting` references:

```ts
{
	kind: "invariant-rejected",
	refused: {
		kind: "every",
		laws: [
			{
				kind: "above",
				level: "Ledger",
				law: {
					kind: "contained",
					from: { relation: "Sitting", terms: [{ kind: "field", field: "package" }], … },
					to: { relation: "Package", terms: [{ kind: "field", field: "id" }], … }
				}
			}
		]
	},
	witness: { kind: "unreported" }
}
```

A Db over `Ledger` meeting the same law names it plainly. Every law an outcome over `S` names is still one of
`lawsOf(S)`, or an `above` law that names its level.

**Recommendation: A.** C silently breaks the promise that `lawsOf(S)` covers every refusal over S. B throws away the
law, which both the snapshot and the top level's apps hold.

## Decision 5: migrations and snapshot layout

**Decided:** how many migration chains, ledgers and snapshots an installation of several levels keeps, and where.

**Options:**

- **A.** One chain per installation, in the root's folder, `migrations/<root>/`, with one `snapshot.json` that records
  every level. There is one ledger and one lock (`<root>.__ledger`, `<root>.__snapshot_guard`), and one folder per
  migration, which may change every level in one transaction.
- **B.** One folder, chain, snapshot and ledger per level, each level's snapshot recording the snapshot of the level
  below it was drafted over.
- **C.** As A, in the top level's folder.

**Worked example (A):** EduLLM's config lists `Ledger`, and `grizzle generate` writes:

```text
install/migrations/qti/
	snapshot.json
	20261109…_init/   creates schemas qti, ledger, ledger__child; Qti's tables, then Ledger's with their foreign keys
	                  into qti; the roles qti__author, ledger__child, qti__author_app, ledger__app; qti.__ledger
```

`snapshot.json` replaces `schemaName` and `schema` with the levels, root first. Each relation's `level` field, already
recorded today, indexes into that list; each login records its level; `theory.schema` is the top level's fingerprint:

```json
"levels": [
	{ "name": "Qti", "schema": "qti", "fingerprint": "…" },
	{ "name": "Ledger", "schema": "ledger", "fingerprint": "…" }
]
```

A level's fingerprint is its chain's owned fingerprint up to that level, every level's name included.

Some changes at a lower level reach a higher one: growing `NodeKind` past a hex digit retypes a Ledger set column, and
changing `Resource`'s key re-points Ledger's foreign key. Both are drafted in the same folder as the Qti change.
Adding a level on top later is the next folder of the same chain. Pantry's `#migrations/qti/snapshot.json` names this
installation's snapshot as soon as pantry is pointed at EduLLM's `install/`.

The commands:

- `generate`, `check` and `migrate` work per installation.
- `drift` compares every level's schema and every role schema with the snapshot: cross-schema foreign keys, triggers
  on lower tables, and policies.
- `names` lists each hashed object with its schema.
- `--rename` and `--drop` names are unique across the installation, as relation names are today.
- A relation moved between levels, or an upper level renamed, is refused by `generate`. The refusal is typed and names
  the relation and both levels; `--drop` and re-adding it is the explicit way. An in-place move (`SET SCHEMA`,
  `ALTER SCHEMA … RENAME`, with role renames) can come later without changing this layout.
- Renaming the root stays what it is today: a new installation.

**Recommendation: A.** A lower change often needs DDL on upper objects in one transaction (drop Ledger's views over a
changed Qti table, alter Qti, recreate them), which B would split across two chains. The database has one ledger and
one lock to fence. Adding a level on top keeps the folder, which C would move.

## Decision 6: the config, logins and names

**Decided:** what a config lists, and which logins it installs.

**Options:**

- **A.** A chain. The config lists each installation once, by its top level. A login over any level of a listed
  installation is installed: its base must be that level by content. Listing a level of another listed schema, or two
  schemas with one root, is refused, naming both. `--schema` takes the configured schema's declared name.
- **B.** A tree. Configured schemas that share a root join one installation: `Ledger` and `Reports`, both over `Qti`,
  install as one, and the snapshot records each level's parent.

**Both options:**

- A login's roles are over the login's own level, as `roleBase` already holds. `ledger__app` cannot hold `Author`;
  pantry keeps `AuthorApp`.
- Login and role names are unique across an installation (`@app` names one login), while their PostgreSQL roles carry
  their level: `qti__author_app`, `ledger__app`.
- A login holds USAGE on the root's schema, SELECT on its ledger and EXECUTE on its guard. That is the fence, wherever
  its level sits.

**Worked example (A):** `schemas: [Ledger], logins: [AuthorApp, LedgerApp]` installs both logins. `schemas: [Qti,
Ledger]` is refused: `Qti` is a level of `Ledger`. Today the first is refused too, with `otherVersion`.

**Recommendation: A.** EduLLM needs a chain, and B can come later on the same root-keyed layout.

## Decision 7: DbLayer.make and Db.open over any level

**Decided:** what a layer over a lower level compiles against. The checks below follow from it.

**Options:**

- **A.** A login is compiled over its own level alone, as pantry already does: `AuthorApp` over `Qti`. It is checked
  against the installation's snapshot, which serves every level it records.
- **B.** A lower login is compiled over the installation's top level. That is impossible for pantry, which does not
  know `Ledger`.

**What A checks.** `DbLayer.make(login over L, snapshot)` checks:

1. The snapshot's seal, as today.
2. `L`'s owned fingerprint is one of the snapshot's levels; otherwise `WorkloadUngenerated` with the fault `schema`,
   as today.
3. The snapshot's codes serve `L`'s rosters.
4. `L`'s artifacts are compiled under those codes, each relation placed in its level's schema.
5. The login's workload access equals the snapshot's record for that login. `generate` computes each login's access
   over its own level, exactly as the layer does.

It compiles nothing of the levels above `L`. The test-only registry of served levels (`levels` and `declaredAs` in
snapshots.ts) is deleted: the snapshot carries its levels, and the test installer mints a unique name for each level.

`Db.open` over a role of `L` runs the same stages:

1. **Version, locale and extensions:** the installation's needs, from the snapshot.
2. **Ledger:** the fence on the root's ledger, and the guard with the installation's one snapshot fingerprint. A
   migration therefore refuses a Db at every level.
3. **Settings and privileges:** the login's and the role's, judged over every level's schema and every role schema
   of the installation, exactly as the snapshot's manifest grants them.
4. **Claims:** judged against the domains of `L`'s copy (Decision 2).

**Worked example:** pantry's `DbLayer.make({ login: AuthorApp, snapshot: install/migrations/qti/snapshot.json, … })`
finds `Qti`'s fingerprint among the levels, compiles Author's programs over `Qti`, and opens. EduLLM's `ledger__app`
layer finds `Ledger`'s. Both fence on `qti.__ledger`.

**Recommendation: A.**

## Decision 8: privileges of a role over an upper level

**Decided:** whether "reads the base whole, read only; writes only its own level" is a rule grizzle imposes, or what a
role declares.

**Options:**

- **A.** The worlds model decides, as today. A role's whole and query entries say what it reads, and its `write` list
  says what it writes. A whole entry of a lower relation is a plain view in the role's schema, owned by the owner, over
  the lower table. The role holds SELECT on the view and no privilege on the lower table. A table listed in `write`
  gets today's grants and policies, at whatever level it sits. The only changes are mechanical: USAGE on each level's
  schema whose objects the role's statements name (today "the base schema"), and admission and drift judging every
  level's schema.
- **B.** Refuse a role over `L` that writes a relation of a level below `L`.

**Worked example (A):** `Child` holds `wholeEntriesOf(Qti)` and writes four Ledger relations:

```sql
CREATE ROLE "ledger__child" NOLOGIN;
GRANT "ledger__child" TO "ledger__app" WITH INHERIT FALSE, SET TRUE;
CREATE SCHEMA "ledger__child";
CREATE VIEW "ledger__child"."resource" AS SELECT … FROM "qti"."resource";
GRANT SELECT ON "ledger__child"."resource" TO "ledger__child";   -- nothing on "qti"."resource"
GRANT USAGE ON SCHEMA "qti", "ledger", "ledger__child" TO "ledger__child";
GRANT USAGE ON DOMAIN "qti"."node_kind" TO "ledger__child";      -- Served.kind's carrier
-- Sitting, Served, Answer, Grade: today's grants and policy for a writable query entry, on "ledger".*
```

A direct `INSERT INTO qti.package` as `ledger__child` fails with 42501. Listing `"Package"` in `write` would be legal,
and would grant exactly what writing it whole grants today.

**Recommendation: A.** It is the mechanism; EduLLM states the policy in its role.

## What changes for existing users

- **A root schema with no extension:** every installed name stays, including the folder `migrations/<schema>/`. The
  snapshot gains its `levels` record, so every committed `snapshot.json` and folder fingerprint changes. Regenerate,
  the hard cutover every release is.
- **A `schema.extend` user:** the call gains a name. The extension's relations, derived relations, roles and logins
  move to its own PostgreSQL schema and `<ext>__*` names (Decision 1). Nothing drafts that move for an installed
  database: an installation built on a same-name extension is reinstalled.
- **Logins over a lower level** are now installed and served (Decisions 6 and 7).
- **Outcomes:** a switch over `law.kind` gains the case `above` (Decision 4).
- **New refusals:** `SchemaRefused` (`levelNameTaken`, `fillsBelow`) when a schema is built; a `generate` refusal of a
  move between levels; config refusals of a listed lower level and of two schemas with one root.

## Tests

The suites below follow CONTRIBUTING: every case runs a search against an oracle, no example lists, and each new rule
comes with a planted bug that some suite must catch, through `pnpm mutate`'s operators.

**Unit, no database:**

- **Level placement and names.** Drawn chains of one to four levels, with drawn relations, rosters, closed and derived
  relations, statements over relations drawn from any level, and roles and logins per level. The oracle is a small
  model of Decisions 1 to 3 written apart from the code: each object's schema, each refusal's rule. It holds every
  installed identifier, `schemaNameOf` and `roleNameOf` to it. Planted bugs: a definition's domain placed in the root
  rather than the level that uses it; a login minted under the root's prefix; a lower `mutable` admitted.
- **Serving levels.** For drawn chains, the snapshot records each level, and `servesSchema` holds exactly for the
  chain's levels. The oracle is the chain itself. It refuses another content and a renamed level. Planted bugs: a layer
  that serves only the top; one that serves any digest.
- **The config.** Drawn configs of installations and logins against a model of Decision 6: a login over any listed
  level, a listed lower level refused, two schemas with one root refused, names alike across levels refused. Planted
  bug: a login over an unlisted level accepted.
- **Startup work and scaling** (the existing call-count and n-to-2n suites) gain the number of levels as a dimension:
  each pass runs once, growth is linear, and `DbLayer.make` over a lower level compiles nothing above it.
- **The differential oracle's** schema generator draws each relation's level, so the conservative lowering, the
  optimized lowering and the reference evaluator agree with relations spread over several schemas.

**PostgreSQL, network:**

- **The worlds model** (test/support/worlds) gains levels: installations of one to three levels, logins over each,
  actions through Db and as direct SQL writers. The model derives each role's reads and writes from its entries;
  reads must equal the model's facts, a direct write outside `write` must be 42501, and no hidden value may leak. This
  is where "reads the base whole, read only" is held. Planted bugs: SELECT on a lower table granted to an upper role;
  USAGE on a level's schema left out.
- **The law families** draw each relation's level. The host law model judges: cross-schema foreign keys and
  rule-over-query triggers refuse exactly what it says, and a lower writer refused from above gets the `above` law the
  model names. Planted bugs: an upper law reported plainly; a fill below admitted.
- **Migration paths:** drawn chains and edits, among them a level added on top, relations added at either level, a
  cross-level containment added or dropped, a lower roster grown past a hex digit while used above, a lower key an
  upper foreign key targets changed, and an upper level dropped with `--drop`. The oracle is a fresh installation of
  the target: the migrated catalog must equal it, the facts must carry over, and drift must be clean. Planted bug: a
  lower change that leaves an upper view standing.
- **Admission and drift:** `Db.open` over every level of a drawn installation is admitted. One drawn difference
  planted in any level's schema or role schema (a privilege, a policy, a view, a missing or extra object) is refused at
  its stage and reported by drift. Planted bug: admission or drift reading only the top's schema.
- **Schedules:** a migration holding the root's ledger refuses `Db.open` at every level; concurrent writers at two
  levels across one containment are held by the history checker.
- **The command line:** `generate`, `check`, `migrate`, `drift` and `names` over a config with a two-level
  installation beside a one-level one, and `--schema` choosing between them.

**Types:**

- The agreement populations draw level chains: a program over any level typechecks exactly where the engine admits it.
- `Schema<Name, …>` carries the extension's own name.
- The README's and SKILL.md's blocks change with their mirrors (Billing, Reporting and the extension examples).

## Releases, and qti-pie

- **Placement.** This lands on grizzle main through the MULTISCHEMA lane and moves the beta.2 candidate. It changes
  the snapshot format, `schema.extend`'s signature and the outcome type, so it ships whole in one release.
- **Rules over queries** (7ff1afbf, and the cutover in flight). A rule's trigger function lives at the rule's level,
  and its deferred constraint triggers sit on the tables it reads, at any level. A lower writer refused by one gets an
  `above` law (Decision 4). The snapshot's `trigger` laws gain their level.
- **One verified hash for qti-pie.** If the hash qti-pie pins is cut before multi-schema lands, qti-pie repins once
  more after. The commit it finally pins must include all of this feature.
- **The repin, then pantry.** qti-pie's fork repacks its three vendored tarballs (`bjornpagen-grizzle`,
  `bjornpagen-grizzle-engine`, `grizzle-testing`) at the landing commit. Then pantry:
  - **Its schema, roles and logins don't change.** `Qti` is a root `schema(...)`, `Author` and `AuthorApp` keep
    `qti__author` and `qti__author_app`, and pantry has no `schema.extend` call.
  - **It regenerates `migrations/qti/`** (the `20261108194543_init` folder and `snapshot.json`), because the snapshot
    gains its levels. A database installed from the old folder is reinstalled.
  - **`src/db/layer.ts` reads `#migrations/qti/snapshot.json`.** Under Decision 5 that path names EduLLM's
    installation snapshot once pantry is pointed at `install/` (`GR8DES_QTI_INSTALL`, already planned). No other
    change follows from it.
  - **No exhaustive switch over `law.kind` in pantry's `src` needs a new case.** Its tests install `Qti` alone and meet
    no `above` law.
  - **It spells `qti__author_app` and `qti__author`** in `src/db/layer.ts`, `src/test/direct-sql.ts` and four tests.
    Those names don't change. Taking them from `roleNameOf` would be the grizzle way, but nothing requires it.
- **EduLLM** then pins `vendor/qti-pie` at that trunk and builds `packages/data/qti-database` with
  `schemas: [Ledger]`.

## Open questions for the grizzle session

1. Same-name extension: confirm it goes. It has 110 mentions in 59 files of grizzle's own tree.
2. Per-level copies of objects named by their definition (2A) or one shared copy (2B), and the foreign key check
   between two copies.
3. The `above` law kind (4A), and its effect on `first` for tables that carry checks from above.
4. A chain now, a tree later (6A), on the root-keyed folder.
5. A move between levels refused by `generate` for now (Decision 5).
6. Outside this feature: every writer holds DELETE today, so EduLLM's "the ledger only adds" is not something grizzle
   can state. Saying it would take an append-only relation, a separate decision.
