import { MWUserInfo } from '../types/index.js';
import { config } from '../config.js';

export async function fetchUserInfo(sessionCookie: string): Promise<MWUserInfo | null> {
  const url = new URL(config.mwApiPath, config.mwBaseUrl);
  url.searchParams.set('action', 'query');
  url.searchParams.set('meta', 'userinfo');
  url.searchParams.set('uiprop', 'groups');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  try {
    const res = await fetch(url.toString(), {
      headers: {
        Cookie: sessionCookie,
        'User-Agent': 'WikiAI-Gateway/0.1',
      },
    });

    if (!res.ok) return null;

    const data = (await res.json()) as any;
    const userinfo = data?.query?.userinfo;

    if (!userinfo || userinfo.id === 0) return null;

    return {
      username: userinfo.name,
      userId: userinfo.id,
      groups: userinfo.groups || ['*'],
    };
  } catch (err) {
    console.error('MW API error:', err);
    return null;
  }
}

export async function userCanRead(sessionCookie: string, pageTitle: string): Promise<boolean> {
  const url = new URL(config.mwApiPath, config.mwBaseUrl);
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', pageTitle);
  url.searchParams.set('prop', 'info');
  url.searchParams.set('inprop', 'readable');
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  try {
    const res = await fetch(url.toString(), {
      headers: {
        Cookie: sessionCookie,
        'User-Agent': 'WikiAI-Gateway/0.1',
      },
    });

    if (!res.ok) return false;

    const data = (await res.json()) as any;
    const pages = data?.query?.pages;
    if (!pages) return false;

    const page = Object.values(pages)[0] as { readable?: string };
    return page?.readable === '';
  } catch (err) {
    console.error('MW userCan error:', err);
    return false;
  }
}
