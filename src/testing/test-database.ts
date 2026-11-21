import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { dropDatabase } from './drop-database';

/**
 * Отдельная база набора: создаётся от адреса суперпользователя PG_TEST_URL.
 * `setup` — операторы схемы, выполняются в новой базе под тем же адресом.
 */
export const createTestDatabase = async (
  adminUrl: string,
  setup: readonly string[] = [],
): Promise<{ url: string; drop(): Promise<void> }> => {
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  if (setup.length > 0) {
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      for (const statement of setup) {
        await client.query(statement);
      }
    } finally {
      await client.end();
    }
  }
  return {
    url: url.toString(),
    drop: async () => {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await dropDatabase(cleanup, name);
      } finally {
        await cleanup.end();
      }
    },
  };
};
