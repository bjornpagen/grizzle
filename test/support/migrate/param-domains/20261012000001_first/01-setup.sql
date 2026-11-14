SELECT "pg_catalog"."pg_advisory_xact_lock"(5448515225636816524::bigint);
DO $$
BEGIN
  EXECUTE "pg_catalog"."format"('ALTER DATABASE %I SET default_transaction_isolation = %L'::"pg_catalog"."text", "pg_catalog"."current_database"(), 'serializable'::"pg_catalog"."text");
END
$$;

CREATE SCHEMA "param_domains";

CREATE DOMAIN "param_domains"."__param_slug_vjseb4e7rj" AS "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" CONSTRAINT "check" CHECK (VALUE IS NULL OR (VALUE ~ '\A[a-z][\-0-9a-z]*\Z'::"pg_catalog"."text") IS TRUE);

CREATE DOMAIN "param_domains"."__text_ypbru4us3x" AS "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" CONSTRAINT "check" CHECK (VALUE IS NULL OR (VALUE ~ '\A[A-Z]{2,6}\Z'::"pg_catalog"."text") IS TRUE);

CREATE DOMAIN "param_domains"."__param_code_st74phcdyy" AS "param_domains"."__text_ypbru4us3x";

CREATE OR REPLACE FUNCTION "param_domains"."__refuse"("state" "pg_catalog"."text", "constraint_name" "pg_catalog"."text", "detail" "pg_catalog"."text") RETURNS boolean
LANGUAGE plpgsql VOLATILE PARALLEL SAFE SECURITY DEFINER SET search_path = "pg_catalog", "pg_temp"
AS $$
BEGIN
  RAISE EXCEPTION 'grizzle refused the statement'
    USING ERRCODE = "state",
          CONSTRAINT = "constraint_name",
          DETAIL = "detail";
END
$$;

REVOKE EXECUTE ON FUNCTION "param_domains"."__refuse"("pg_catalog"."text", "pg_catalog"."text", "pg_catalog"."text") FROM PUBLIC;

CREATE OR REPLACE FUNCTION "param_domains"."__require_serializable"() RETURNS "pg_catalog"."trigger"
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "pg_catalog", "pg_temp"
AS $$
BEGIN
  IF "pg_catalog"."current_setting"('transaction_isolation'::"pg_catalog"."text") <> 'serializable'::"pg_catalog"."text" THEN
    RAISE EXCEPTION 'a write to a grizzle table requires SERIALIZABLE'
      USING ERRCODE = 'invalid_transaction_state'::"pg_catalog"."text",
            SCHEMA = TG_TABLE_SCHEMA,
            TABLE = TG_TABLE_NAME,
            HINT = 'write at SERIALIZABLE'::"pg_catalog"."text";
  END IF;
  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION "param_domains"."__require_serializable"() FROM PUBLIC;

CREATE TABLE "param_domains"."__ledger" (
  "folder" "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" NOT NULL,
  "ordinal" integer NOT NULL,
  "file" "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" NOT NULL,
  "source" "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" NOT NULL,
  "target" "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" NOT NULL,
  "files" integer NOT NULL,
  "digest" "pg_catalog"."text" COLLATE "pg_catalog"."pg_c_utf8" NOT NULL,
  CONSTRAINT "__ledger_pk" PRIMARY KEY ("folder", "ordinal"),
  CONSTRAINT "__ledger_ordinal_check" CHECK (("ordinal" >= 0) IS TRUE),
  CONSTRAINT "__ledger_files_check" CHECK (("files" >= 0) IS TRUE)
);

REVOKE ALL ON TABLE "param_domains"."__ledger" FROM PUBLIC;

CREATE TRIGGER "__isolation"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "param_domains"."__ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION "param_domains"."__require_serializable"();

CREATE OR REPLACE FUNCTION "param_domains"."__snapshot_guard"("fingerprint" "pg_catalog"."text") RETURNS "pg_catalog"."void"
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "pg_catalog", "pg_temp"
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "param_domains"."__ledger" AS "r1" WHERE "r1"."ordinal" = 0 AND "r1"."files" <> (SELECT "pg_catalog"."count"(*) FROM "param_domains"."__ledger" AS "r2" WHERE "r2"."folder" = "r1"."folder" AND "r2"."ordinal" <> 0)) THEN
    RAISE EXCEPTION 'a grizzle migration of this schema is running or stopped part-way'
      USING ERRCODE = '55Z02'::"pg_catalog"."text";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "param_domains"."__ledger" AS "r3" WHERE "r3"."ordinal" = 0 AND "r3"."target" = "fingerprint" AND NOT EXISTS (SELECT 1 FROM "param_domains"."__ledger" AS "r4" WHERE "r4"."ordinal" = 0 AND "r4"."folder" > "r3"."folder")) THEN
    RAISE EXCEPTION 'the latest grizzle migration of this schema is not the snapshot of this Db'
      USING ERRCODE = '55Z01'::"pg_catalog"."text";
  END IF;
END
$$;

REVOKE EXECUTE ON FUNCTION "param_domains"."__snapshot_guard"("pg_catalog"."text") FROM PUBLIC;
