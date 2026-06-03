#!/usr/bin/env node
import {
  CORPORATE_PAGE_ACL_RULES,
  CORPORATE_USERS,
} from './corporate-content-fixtures.mjs';
import { MediaWikiApiClient, MediaWikiApiError } from './mediawiki-api-client.mjs';

const mwBaseUrl = process.env.MW_BASE_URL ?? 'http://localhost:8082';
const seedPassword = process.env.MW_SEED_PASSWORD;

if (process.env.RUN_MW_SEED_LIVE !== '1') {
  console.log('Skipping live corporate ACL verification. Set RUN_MW_SEED_LIVE=1 to run it.');
  process.exit(0);
}

if (!seedPassword) {
  console.error('Missing required env MW_SEED_PASSWORD.');
  process.exit(1);
}

const checks = [
  {
    title: 'CorpCommon:Приказы/Режим рабочего времени',
    expected: {
      wiki_hr_user: true,
      wiki_fin_user: true,
      wiki_it_user: true,
      wiki_exec_user: true,
    },
  },
  {
    title: 'CorpHR:Кадровое администрирование/Регламент обработки кадровых заявок',
    expected: {
      wiki_hr_user: true,
      wiki_fin_user: false,
      wiki_it_user: false,
      wiki_exec_user: true,
    },
  },
  {
    title: 'CorpFinance:Бюджетирование/Регламент план-факт анализа',
    expected: {
      wiki_hr_user: false,
      wiki_fin_user: true,
      wiki_it_user: false,
      wiki_exec_user: true,
    },
  },
  {
    title: 'CorpIT:Service Desk/Регламент обработки заявок',
    expected: {
      wiki_hr_user: false,
      wiki_fin_user: false,
      wiki_it_user: true,
      wiki_exec_user: true,
    },
  },
  ...CORPORATE_PAGE_ACL_RULES.map((rule) => ({
    title: rule.title,
    expected: {
      wiki_hr_user: rule.groups.includes('ai-hr'),
      wiki_fin_user: rule.groups.includes('ai-finance'),
      wiki_it_user: rule.groups.includes('ai-it'),
      wiki_exec_user: rule.groups.includes('ai-exec'),
    },
  })),
];

try {
  const clients = new Map();
  for (const user of CORPORATE_USERS) {
    const client = new MediaWikiApiClient(mwBaseUrl);
    await client.login(user.username, seedPassword);
    const info = await client.getCurrentUserInfo();
    for (const group of user.groups) {
      if (!info.groups.includes(group)) {
        throw new Error(`${user.username} is missing expected group ${group}`);
      }
    }
    clients.set(user.username, client);
  }

  let failures = 0;
  for (const check of checks) {
    for (const [username, expected] of Object.entries(check.expected)) {
      const actual = await clients.get(username).canRead(check.title);
      const status = actual === expected ? 'OK' : 'FAIL';
      console.log(`[${status}] ${username} read ${check.title}: expected=${expected} actual=${actual}`);
      if (actual !== expected) failures++;
    }
  }

  if (failures > 0) {
    throw new Error(`Corporate ACL verification failed: ${failures} mismatch(es)`);
  }

  console.log('Corporate ACL live verification passed.');
} catch (err) {
  if (err instanceof MediaWikiApiError) {
    console.error(err.message);
    if (err.details?.info) {
      console.error(err.details.info);
    }
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
}
