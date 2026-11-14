SELECT "pg_catalog"."pg_advisory_xact_lock"(5448515225636816524::bigint);
REVOKE ALL ON SCHEMA "param_domains" FROM PUBLIC;

REVOKE ALL ON TABLE "param_domains"."coded", "param_domains"."item" FROM PUBLIC;

REVOKE ALL ON DOMAIN "param_domains"."__text_ypbru4us3x", "param_domains"."__param_code_st74phcdyy", "param_domains"."__param_slug_vjseb4e7rj" FROM PUBLIC;

SELECT "pg_catalog"."pg_advisory_xact_lock"(5448515225636816524::bigint);
ALTER DEFAULT PRIVILEGES IN SCHEMA "param_domains" REVOKE ALL ON TABLES FROM PUBLIC;

SELECT "pg_catalog"."pg_advisory_xact_lock"(5448515225636816524::bigint);
ALTER DEFAULT PRIVILEGES IN SCHEMA "param_domains" REVOKE ALL ON SEQUENCES FROM PUBLIC;

SELECT "pg_catalog"."pg_advisory_xact_lock"(5448515225636816524::bigint);
ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM PUBLIC;

SELECT "pg_catalog"."pg_advisory_xact_lock"(5448515225636816524::bigint);
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TYPES FROM PUBLIC;

COMMENT ON DOMAIN "param_domains"."__param_slug_vjseb4e7rj" IS 'pattern domain of parameter slug of definition 8425fd26634c446e376874ca4cbddf8b0fa32ecd8064e385719789324bd24ea8';

COMMENT ON DOMAIN "param_domains"."__text_ypbru4us3x" IS 'text domain of definition 1a222598f3ed10fba881bca18ba4d12192882c7c6cbb5cc46685ba6181d45cfa';

COMMENT ON DOMAIN "param_domains"."__param_code_st74phcdyy" IS 'pattern domain of parameter code of definition 1a222598f3ed10fba881bca18ba4d12192882c7c6cbb5cc46685ba6181d45cfa';

COMMENT ON CONSTRAINT "__coded_pk_7tyvcoagbh" ON "param_domains"."coded" IS 'primary key of Coded';

COMMENT ON CONSTRAINT "__item_pk_ai4obgmq4k" ON "param_domains"."item" IS 'primary key of Item';
