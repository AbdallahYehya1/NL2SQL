import { LexicalIndex } from "@/lib/metadata/lexical";
import { builtinIndex, createRegistryIndex, DATA_SCHEMA, type RegistryIndex } from "@/lib/metadata/registry";
import type { MetadataRegistry } from "@/lib/types";

/**
 * A DatasetContext is everything the generic NL2SQL engine needs to know about ONE dataset: which PostgreSQL schema
 * it lives in, which role may read it, and its metadata registry (+ derived indexes). The pipeline receives a context
 * explicitly — there is no global "current dataset" — so a query cannot silently run against the wrong data.
 */

export const DEMO_DATASET_ID = "demo";

export type DatasetSourceType = "builtin" | "sql" | "csv";

export interface DatasetContext {
  id: string;
  name: string;
  sourceType: DatasetSourceType;
  /** PostgreSQL schema holding the dataset's tables. The only schema generated SQL may touch. */
  schemaName: string;
  /** Read-only role used to execute queries (undefined → the configured default role of the built-in demo). */
  executionRole?: string;
  /** One-line description used in prompts ("a retail analytics database …"). */
  description: string;
  /** Words used in refusal messages ("Try asking about …"). */
  topics: string[];
  clarificationOptions: string[];
  /** Asked when a question names no measure at all ("What were the sales?"). */
  clarificationQuestion: string;
  /** Starter questions shown in the UI; undefined → generated from the registry (uploaded datasets). */
  suggestedQuestions?: string[];
  /** Example phrases shown to the question-analysis model (dataset-specific wording, no logic). */
  promptExamples: PromptExamples;
  index: RegistryIndex;
  registry: MetadataRegistry;
  /** Lexical index over this dataset's metadata (built lazily, cached). */
  lexical: LexicalIndex;
}

export interface PromptExamples {
  /** Questions that name a measure and therefore need no clarification. */
  noClarification: string;
  concepts: string;
  searchTerms: string;
}

export interface DatasetContextInit {
  id: string;
  name: string;
  sourceType: DatasetSourceType;
  schemaName: string;
  executionRole?: string;
  registry: MetadataRegistry;
  description?: string;
  topics?: string[];
  clarificationOptions?: string[];
  clarificationQuestion?: string;
  suggestedQuestions?: string[];
  promptExamples?: PromptExamples;
  index?: RegistryIndex;
}

const GENERIC_PROMPT_EXAMPLES: PromptExamples = {
  noClarification: '"Top 5 rows by a numeric column", "How many records are there?", "Average of a numeric column per category", "List the values of a column"',
  concepts: '"count", "average", "grouping column"',
  searchTerms: 'a synonym of a table or column name mentioned in the question',
};

const GENERIC_CLARIFICATION_QUESTION = "Which measure would you like to see, and for what period or grouping?";
const GENERIC_CLARIFICATION_OPTIONS = ["A count of records", "A total or average of a numeric column", "A breakdown by category"];

export function createDatasetContext(init: DatasetContextInit): DatasetContext {
  const index = init.index ?? createRegistryIndex(init.registry);
  const names = index.tableNames;
  let lexical: LexicalIndex | undefined;
  return {
    id: init.id,
    name: init.name,
    sourceType: init.sourceType,
    schemaName: init.schemaName,
    executionRole: init.executionRole,
    description: init.description ?? `a user-provided database "${init.name}" with the tables ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}`,
    topics: init.topics ?? names.slice(0, 6),
    clarificationOptions: init.clarificationOptions ?? GENERIC_CLARIFICATION_OPTIONS,
    clarificationQuestion: init.clarificationQuestion ?? GENERIC_CLARIFICATION_QUESTION,
    suggestedQuestions: init.suggestedQuestions,
    promptExamples: init.promptExamples ?? GENERIC_PROMPT_EXAMPLES,
    index,
    registry: init.registry,
    get lexical() {
      return (lexical ??= new LexicalIndex(index.items));
    },
  };
}

let builtin: DatasetContext | undefined;

/** The built-in 20-table e-commerce demo dataset (schema `shop`). Available without any database lookup. */
export function getBuiltinContext(): DatasetContext {
  return (builtin ??= createDatasetContext({
    id: DEMO_DATASET_ID,
    name: "E-commerce Demo",
    sourceType: "builtin",
    schemaName: DATA_SCHEMA,
    registry: builtinIndex.registry,
    index: builtinIndex,
    description: "a retail analytics database (online orders, in-store sales, products, customers, inventory, suppliers, employees, promotions, reviews)",
    topics: ["customers", "orders", "products", "revenue", "inventory", "sales"],
    clarificationOptions: ["Total revenue (sum of order line totals)", "Number of orders", "Units sold"],
    clarificationQuestion: "Which measure would you like to see (for example revenue, number of orders or units sold), and for what period or grouping?",
    suggestedQuestions: ["Top 5 products by revenue", "Monthly revenue for the last 6 months", "Customers with more than 3 orders", "Which categories have declining sales?", "Which products are low in stock?"],
    promptExamples: {
      noClarification: '"Top 5 products by revenue", "How many customers are there?", "Average order value", "Which products are low in stock?", "Monthly revenue trend"',
      concepts: '"revenue", "customers", "inventory"',
      searchTerms: 'for "biggest spenders" → "customer lifetime value", "orders"',
    },
  }));
}
