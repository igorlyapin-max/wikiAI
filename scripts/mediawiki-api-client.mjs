export class MediaWikiApiError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'MediaWikiApiError';
    this.details = details;
  }
}

export class MediaWikiApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiUrl = `${this.baseUrl}/api.php`;
    this.cookies = new Map();
  }

  cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  captureCookies(response) {
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : splitSetCookieHeader(response.headers.get('set-cookie'));

    for (const cookie of setCookies) {
      const [pair] = cookie.split(';', 1);
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  async request(params, { method = 'GET' } = {}) {
    const url = new URL(this.apiUrl);
    const headers = {
      'User-Agent': 'WikiAI-CorporateSeed/0.1',
    };
    const cookie = this.cookieHeader();
    if (cookie) {
      headers.Cookie = cookie;
    }

    let body;
    if (method === 'GET') {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          body.set(key, String(value));
        }
      }
    }

    const response = await fetch(url, { method, headers, body });
    this.captureCookies(response);
    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new MediaWikiApiError(`MediaWiki returned non-JSON response (${response.status})`, {
        status: response.status,
        bodyStart: text.slice(0, 200),
      });
    }

    if (!response.ok) {
      throw new MediaWikiApiError(`MediaWiki HTTP error ${response.status}`, data);
    }
    if (data.error) {
      throw new MediaWikiApiError(`MediaWiki API error: ${data.error.code}`, data.error);
    }

    return data;
  }

  async getToken(type = 'csrf') {
    const data = await this.request({
      action: 'query',
      meta: 'tokens',
      type,
      format: 'json',
    });
    const key = type === 'csrf' ? 'csrftoken' : `${type}token`;
    const token = data?.query?.tokens?.[key];
    if (!token || token === '+\\') {
      throw new MediaWikiApiError(`Failed to get ${type} token`, data);
    }
    return token;
  }

  async login(username, password) {
    const token = await this.getToken('login');
    const data = await this.request({
      action: 'login',
      lgname: username,
      lgpassword: password,
      lgtoken: token,
      format: 'json',
    }, { method: 'POST' });

    if (data?.login?.result !== 'Success') {
      throw new MediaWikiApiError(`Login failed: ${data?.login?.result ?? 'unknown'}`, data.login);
    }
  }

  async siteInfo() {
    return this.request({
      action: 'query',
      meta: 'siteinfo',
      siprop: 'namespaces|usergroups',
      format: 'json',
    });
  }

  async getCurrentUserInfo() {
    const data = await this.request({
      action: 'query',
      meta: 'userinfo',
      uiprop: 'groups|rights',
      format: 'json',
    });
    return data.query.userinfo;
  }

  async getUser(username) {
    const data = await this.request({
      action: 'query',
      list: 'users',
      ususers: username,
      usprop: 'groups',
      format: 'json',
    });
    const user = data?.query?.users?.[0];
    return {
      exists: Boolean(user && !user.missing),
      groups: Array.isArray(user?.groups) ? user.groups : [],
    };
  }

  async createAccount({ username, password, email, realName }) {
    const current = await this.getUser(username);
    if (current.exists) {
      return { created: false };
    }

    const token = await this.getToken('createaccount');
    const data = await this.request({
      action: 'createaccount',
      username,
      password,
      retype: password,
      email,
      realname: realName,
      createtoken: token,
      createreturnurl: `${this.baseUrl}/`,
      format: 'json',
    }, { method: 'POST' });

    const status = data?.createaccount?.status;
    if (status !== 'PASS') {
      throw new MediaWikiApiError(`Create account failed for ${username}: ${status ?? 'unknown'}`, data.createaccount);
    }

    return { created: true };
  }

  async addUserGroups(username, groups) {
    const current = await this.getUser(username);
    const missingGroups = groups.filter((group) => !current.groups.includes(group));
    if (missingGroups.length === 0) {
      return { changed: false };
    }

    let token;
    try {
      token = await this.getToken('userrights');
    } catch {
      token = await this.getToken('csrf');
    }

    await this.request({
      action: 'userrights',
      user: username,
      add: missingGroups.join('|'),
      reason: 'WikiAI corporate test seed',
      token,
      format: 'json',
    }, { method: 'POST' });

    return { changed: true, added: missingGroups };
  }

  async editPage(title, text, summary) {
    const token = await this.getToken('csrf');
    const data = await this.request({
      action: 'edit',
      title,
      text,
      summary,
      token,
      bot: 1,
      format: 'json',
    }, { method: 'POST' });

    if (data?.edit?.result !== 'Success') {
      throw new MediaWikiApiError(`Edit failed for ${title}`, data.edit);
    }

    return data.edit;
  }

  async canRead(title) {
    const data = await this.request({
      action: 'query',
      titles: title,
      prop: 'info',
      inprop: 'readable',
      format: 'json',
    });
    const pages = Object.values(data?.query?.pages ?? {});
    const page = pages[0];
    return Boolean(page && page.readable === '');
  }
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,\s]+=)/g).map((cookie) => cookie.trim());
}
