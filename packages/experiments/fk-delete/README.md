# fk-delete (experiment, FKDELETE, 2026-11-15)

What it tests: where the COMMIT of a whole-package delete in edullm's QTI database spends its CPU, and how much of it a
guarded landing removes. BULKLOAD-BATCH measured about 70 s of server CPU at COMMIT for one package (g3t15) of 43, nearly
all of it PostgreSQL's deferred NO ACTION foreign key checks. PostgreSQL 19 queues one such check per deleted row and per
foreign key into its table whose referenced columns all hold a value there (trigger.c AfterTriggerSaveEvent,
ri_triggers.c RI_FKey_pk_upd_check_required), and runs two SPI queries for each at COMMIT (ri_restrict,
ri_Check_Pk_Match). A landing guarded by the values its referencing columns can hold leaves a null at every row no
referencing row can name, so no check is queued for it.

Nothing here is code grizzle runs. No test reads it. The database is a production-shaped 19rc1 cluster set up with
edullm-repin's harness (`init-cluster.sh`, `setup.sh`, `run-profile.sh`), edullm staging generated over grizzle main,
the two REPIN2 packages published into it.

- `census.py <psql> <socket> <port> <db> <package>`: per foreign key, the checks deleting the package queues and how
  many of them find a referencing row, from the stored rows, deleting nothing.
- `measure.py <psql> <socket> <port> <db> <package> <all|none> <variant sql|->`: the package's whole delete in one
  SERIALIZABLE transaction, the deferred checks fired by SET CONSTRAINTS ALL IMMEDIATE (the work COMMIT does), then
  ROLLBACK; each step's backend CPU, and with pg_stat_statements tracking nested statements the RI queries' calls.
- `variant.py <psql> <socket> <port> <db> <table> <field> <guarded> <union|each|drop>`: DDL measure.py runs inside the
  transaction before the deletes: the foreign keys into `<table>` that pair a column with `<field>` re-pointed at a
  landing guarded by the values their referencing columns hold (`union`: one per referenced column list; `each`: one per
  foreign key), or dropped (`drop`, the bound).

Verdict that ends it: main chooses the landing grizzle generates for these foreign keys, and that change lands with its
law, plant and edullm draft; or main keeps today's landings. Then this package is deleted in one commit.
