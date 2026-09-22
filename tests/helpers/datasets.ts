import { createDatasetContext, type DatasetContext } from "@/lib/datasets/context";
import { getUploadLimits, type UploadLimits } from "@/lib/datasets/limits";
import { buildRegistryFromIntrospection } from "@/lib/datasets/metadata-builder";
import type { IntrospectedSchema } from "@/lib/datasets/introspect";

/** Fixtures for the dataset-upload tests. All data is synthetic. */

export const COMPANY_SQL = `
-- Company HR sample
CREATE TABLE public.departments (
  id serial PRIMARY KEY,
  name text NOT NULL,
  location text
);
CREATE TABLE public.employees (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text,
  department_id integer REFERENCES public.departments(id),
  hire_date date,
  status text CHECK (status IN ('active', 'on_leave', 'left'))
);
CREATE TABLE public.salaries (
  id serial PRIMARY KEY,
  employee_id integer NOT NULL,
  amount numeric(10,2) NOT NULL,
  effective_date date
);
ALTER TABLE ONLY public.salaries ADD CONSTRAINT salaries_employee_fk FOREIGN KEY (employee_id) REFERENCES public.employees(id);
CREATE INDEX idx_employees_department ON public.employees USING btree (department_id);
COMMENT ON TABLE public.departments IS 'Company departments';
COMMENT ON COLUMN public.employees.status IS 'Employment status';
INSERT INTO public.departments (id, name, location) VALUES (1, 'Engineering', 'Berlin'), (2, 'Sales', 'Paris'), (3, 'HR', 'Berlin');
INSERT INTO public.employees (id, name, email, department_id, hire_date, status) VALUES
  (1, 'Ada Byron', 'ada@corp.example', 1, '2020-01-15', 'active'),
  (2, 'Grace Hopper', 'grace@corp.example', 1, '2019-06-01', 'active'),
  (3, 'Linus Torvalds', 'linus@corp.example', 2, '2021-03-20', 'on_leave'),
  (4, 'Alan Turing', 'alan@corp.example', 3, '2018-11-11', 'left'),
  (5, 'Edsger Dijkstra', 'edsger@corp.example', 2, '2022-02-02', 'active');
INSERT INTO public.salaries (id, employee_id, amount, effective_date) VALUES
  (1, 1, 120000.00, '2024-01-01'), (2, 2, 135000.00, '2024-01-01'), (3, 3, 80000.00, '2024-01-01'),
  (4, 4, 70000.00, '2024-01-01'), (5, 5, 90000.00, '2024-01-01');
`;

/** A second dataset with the SAME table name as COMPANY_SQL but different data — used for isolation tests. */
export const OTHER_SQL = `
CREATE TABLE employees (id integer PRIMARY KEY, name text, team text);
INSERT INTO employees (id, name, team) VALUES (1, 'Zed', 'Ops'), (2, 'Yan', 'Ops');
`;

export const CUSTOMERS_CSV = `id,name,city,signup_date,vip
1,Alice,Paris,2023-01-05,true
2,Bob,Berlin,2023-02-11,false
3,Chloé,Paris,2023-03-30,false
4,Dan,Rome,2023-04-02,true
`;
export const ORDERS_CSV = `order_id,customer_id,amount,ordered_at
100,1,25.50,2024-01-01
101,1,10.00,2024-01-03
102,2,99.99,2024-02-01
103,4,5.25,2024-02-14
104,3,60.00,2024-03-01
`;
export const ORPHAN_ORDERS_CSV = `order_id,customer_id,amount
1,1,10
2,999,20
`;

export const TEST_LIMITS: UploadLimits = { ...getUploadLimits({}), maxUploadsPerHour: 1000, maxDatasetsPerSession: 50 };

/** A dataset context built from a hand-written introspection result (no database needed). */
export function fixtureContext(id = "ds_fixture", name = "Company HR"): DatasetContext {
  const schema: IntrospectedSchema = {
    tables: [
      {
        name: "departments",
        rowCount: 3,
        primaryKey: ["id"],
        foreignKeys: [],
        uniqueKeys: [],
        columns: [
          { name: "id", type: "integer", nullable: false, hasDefault: true, distinctCount: 3, sampleValues: ["1", "2", "3"] },
          { name: "name", type: "text", nullable: false, hasDefault: false, distinctCount: 3, sampleValues: ["Engineering", "HR", "Sales"] },
        ],
      },
      {
        name: "employees",
        rowCount: 5,
        primaryKey: ["id"],
        foreignKeys: [{ columns: ["department_id"], refTable: "departments", refColumns: ["id"] }],
        uniqueKeys: [],
        columns: [
          { name: "id", type: "integer", nullable: false, hasDefault: true, distinctCount: 5, sampleValues: [] },
          { name: "name", type: "text", nullable: false, hasDefault: false, distinctCount: 5, sampleValues: [] },
          { name: "department_id", type: "integer", nullable: true, hasDefault: false, distinctCount: 3, sampleValues: [] },
        ],
      },
      {
        name: "salaries",
        rowCount: 5,
        primaryKey: ["id"],
        foreignKeys: [{ columns: ["employee_id"], refTable: "employees", refColumns: ["id"] }],
        uniqueKeys: [],
        columns: [
          { name: "id", type: "integer", nullable: false, hasDefault: true, distinctCount: 5, sampleValues: [] },
          { name: "employee_id", type: "integer", nullable: false, hasDefault: false, distinctCount: 5, sampleValues: [] },
          { name: "amount", type: "numeric(10,2)", nullable: false, hasDefault: false, distinctCount: 5, sampleValues: ["120000.00", "135000.00"] },
        ],
      },
    ],
  };
  return createDatasetContext({ id, name, sourceType: "sql", schemaName: id, registry: buildRegistryFromIntrospection(schema) });
}
