/** Connection string of the throw-away database created by tests/integration/global-setup.ts. */
export function testDatabaseUrl(): string {
  const adminUrl = process.env.TEST_ADMIN_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
  return adminUrl.replace(/\/[^/?]*(\?|$)/, "/nl2sql_test$1");
}

/** Point the app's config at the test database. Call before importing modules that read DATABASE_URL. */
export function pointAtTestDatabase() {
  process.env.DATABASE_URL = testDatabaseUrl();
  delete process.env.READONLY_DATABASE_URL;
}
