/** Base y Redis exclusivos de los tests, derivados de los de desarrollo. */
export function testEnv(env: NodeJS.ProcessEnv) {
  const withDb = (url: string | undefined, db: string) => {
    if (!url) return url;
    const u = new URL(url);
    u.pathname = `/${db}`;
    return u.toString();
  };
  return {
    DATABASE_URL: env.TEST_DATABASE_URL ?? withDb(env.DATABASE_URL, 'citara_test'),
    DATABASE_ADMIN_URL: env.TEST_DATABASE_ADMIN_URL ?? withDb(env.DATABASE_ADMIN_URL, 'citara_test'),
    REDIS_URL: env.TEST_REDIS_URL ?? withDb(env.REDIS_URL, '1'),
  };
}
