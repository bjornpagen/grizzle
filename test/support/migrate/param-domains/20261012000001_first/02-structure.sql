CREATE TABLE "param_domains"."coded" (
  "id" "pg_catalog"."uuid" NOT NULL,
  "code" "param_domains"."__text_ypbru4us3x" NOT NULL,
  CONSTRAINT "__coded_pk_7tyvcoagbh" PRIMARY KEY ("id")
);

CREATE TABLE "param_domains"."item" (
  "id" "pg_catalog"."uuid" NOT NULL,
  "n" integer NOT NULL,
  CONSTRAINT "__item_pk_ai4obgmq4k" PRIMARY KEY ("id")
);

CREATE TRIGGER "__isolation"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "param_domains"."coded"
  FOR EACH STATEMENT EXECUTE FUNCTION "param_domains"."__require_serializable"();

CREATE TRIGGER "__isolation"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "param_domains"."item"
  FOR EACH STATEMENT EXECUTE FUNCTION "param_domains"."__require_serializable"();
