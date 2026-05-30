export interface MWPage {
  pageid: number;
  ns: number;
  title: string;
  content?: string;
}

export async function fetchPageContent(title: string): Promise<MWPage | null> {
  const base = process.env.MW_BASE_URL ?? 'http://localhost:8082';
  const url = new URL('/api.php', base);
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', title);
  url.searchParams.set('prop', 'revisions');
  url.searchParams.set('rvprop', 'content');
  url.searchParams.set('rvslots', 'main');
  url.searchParams.set('format', 'json');

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const pages = data.query?.pages;
    if (!pages) return null;

    const page = Object.values(pages)[0] as any;
    if (page.missing) return null;

    const revision = page.revisions?.[0];
    const content = revision?.slots?.main?.['*'] ?? revision?.['*'] ?? '';

    return { pageid: page.pageid, ns: page.ns, title: page.title, content };
  } catch (err) {
    console.error('Fetch page error:', err);
    return null;
  }
}

export async function fetchAllPages(namespace?: number): Promise<Array<{ pageid: number; ns: number; title: string }>> {
  const results: Array<{ pageid: number; ns: number; title: string }> = [];
  let apcontinue: string | undefined;

  do {
    const base = process.env.MW_BASE_URL ?? 'http://localhost:8082';
    const url = new URL('/api.php', base);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'allpages');
    url.searchParams.set('aplimit', '500');
    url.searchParams.set('format', 'json');
    if (namespace !== undefined) url.searchParams.set('apnamespace', String(namespace));
    if (apcontinue) url.searchParams.set('apcontinue', apcontinue);

    const res = await fetch(url.toString());
    const data = (await res.json()) as any;
    const pages = data.query?.allpages ?? [];
    results.push(...pages);
    apcontinue = data.continue?.apcontinue;
  } while (apcontinue);

  return results;
}

export interface MWFile {
  filename: string;
  url: string;
  mime: string;
  size: number;
}

export async function fetchPageFiles(title: string): Promise<string[]> {
  const base = process.env.MW_BASE_URL ?? 'http://localhost:8082';
  const url = new URL('/api.php', base);
  url.searchParams.set('action', 'parse');
  url.searchParams.set('page', title);
  url.searchParams.set('prop', 'images');
  url.searchParams.set('format', 'json');

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    const images: string[] = data.parse?.images ?? [];
    return images.filter((name: string) => !name.startsWith('Page_'));
  } catch (err) {
    console.error('Fetch page files error:', err);
    return [];
  }
}

export async function fetchFileInfo(filename: string): Promise<MWFile | null> {
  const base = process.env.MW_BASE_URL ?? 'http://localhost:8082';
  const url = new URL('/api.php', base);
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', `File:${filename}`);
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|size|mime');
  url.searchParams.set('format', 'json');

  try {
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const pages = data.query?.pages;
    if (!pages) return null;

    const page = Object.values(pages)[0] as any;
    if (page.missing) return null;

    const info = page.imageinfo?.[0];
    if (!info) return null;

    return {
      filename,
      url: info.url,
      mime: info.mime,
      size: info.size,
    };
  } catch (err) {
    console.error('Fetch file info error:', err);
    return null;
  }
}

export async function downloadFile(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.error('Download file error:', err);
    return null;
  }
}
