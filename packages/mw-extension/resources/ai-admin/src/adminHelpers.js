export function createAIAdminEndpoint({ apiBase = '', adminProxyEnabled = false, locationHref } = {}) {
  return (path) => {
    if (!adminProxyEnabled) return apiBase + path;
    const url = new URL(locationHref || window.location.href);
    url.searchParams.set('aiadmin-proxy', '1');
    url.searchParams.set('path', path);
    return url.toString();
  };
}

export function activateAIAdminTab(name, root = document) {
  root.querySelectorAll('.ai-admin-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.aiTab === name);
  });
  root.querySelectorAll('.ai-admin-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.aiPanel === name);
  });
}

export function applyAIAdminTranslations(root, i18n, mappings) {
  mappings.forEach(([selector, key]) => {
    const node = root.querySelector(selector);
    if (node) node.textContent = i18n[key] || key;
  });
}

function helperText(i18n, key, fallback = key) {
  return i18n?.[key] || fallback;
}

function helperFormatText(i18n, key, values = {}, fallback = key) {
  return Object.entries(values)
    .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value ?? '')), helperText(i18n, key, fallback));
}

function helperYesNo(i18n, value) {
  return value ? helperText(i18n, 'aiadmin-value-yes', 'yes') : helperText(i18n, 'aiadmin-value-no', 'no');
}

function helperUnknown(i18n) {
  return helperText(i18n, 'aiadmin-value-unknown', 'unknown');
}

function appendMediaWikiTableCell(row, value) {
  const cell = document.createElement('td');
  cell.textContent = String(value ?? '');
  row.appendChild(cell);
}

function mediaWikiLexicalBackendLabel(i18n, value) {
  return value === 'opensearch'
    ? 'OpenSearch'
    : helperText(i18n, 'aiadmin-value-lexical-backend-sqlite', 'BM25/trigram');
}

function mediaWikiSearchModeLabel(i18n, value) {
  if (value === 'vector_only') return helperText(i18n, 'aiadmin-value-search-mode-vector-only', 'Vector only');
  if (value === 'colbert_full') return helperText(i18n, 'aiadmin-value-search-mode-colbert-full', 'ColBERT full');
  if (value === 'hybrid_colbert') return helperText(i18n, 'aiadmin-value-search-mode-hybrid-colbert', 'Hybrid + ColBERT');
  return helperText(i18n, 'aiadmin-value-search-mode-hybrid', 'Hybrid');
}

function mediaWikiRerankModeLabel(i18n, value) {
  return value === 'colbert_v2'
    ? helperText(i18n, 'aiadmin-value-rerank-colbert-v2', 'ColBERTv2')
    : helperText(i18n, 'aiadmin-value-rerank-none', 'No rerank');
}

function mediaWikiChatRetrievalModeLabel(i18n, value) {
  return value === 'history_augmented'
    ? helperText(i18n, 'aiadmin-value-chat-retrieval-history-augmented', 'Current query + history')
    : helperText(i18n, 'aiadmin-value-chat-retrieval-current-message', 'Current query only');
}

function mediaWikiProfileLabel(i18n, profile) {
  const config = profile.config || {};
  return [
    profile.name,
    mediaWikiLexicalBackendLabel(i18n, config.lexicalBackend || 'sqlite_fts'),
    mediaWikiSearchModeLabel(i18n, config.searchMode || 'hybrid'),
    mediaWikiRerankModeLabel(i18n, config.rerankMode || 'none'),
    profile.readiness?.status || helperUnknown(i18n),
  ].join(' / ');
}

function isOpenSearchProfile(profile) {
  const tags = Array.isArray(profile.tags) ? profile.tags : [];
  return profile.config?.lexicalBackend === 'opensearch'
    || String(profile.id || '').startsWith('opensearch_')
    || tags.includes('opensearch');
}

function appendMediaWikiProfileActions(root, i18n, options = {}) {
  const actions = document.createElement('div');
  actions.className = 'ai-admin-row';
  const buttons = [
    `<button type="button" class="ai-admin-btn" id="aiadmin-refresh-mediawiki-profile">${helperText(i18n, 'aiadmin-action-refresh-status')}</button>`,
    `<button type="button" class="ai-admin-btn" id="aiadmin-open-retrieval-profiles">${helperText(i18n, 'aiadmin-tab-retrieval-profiles')}</button>`,
  ];
  if (options.includeRestore) {
    buttons.push(`<button type="button" class="ai-admin-btn" id="aiadmin-restore-mediawiki-retrieval-profiles">${helperText(i18n, 'aiadmin-action-restore-retrieval-profiles')}</button>`);
  }
  actions.innerHTML = buttons.join('');
  root.appendChild(actions);
}

export async function loadMediaWikiProfilePayload(request) {
  const data = await request('/api/admin/mediawiki-profile/config');
  const profiles = Array.isArray(data.retrievalProfiles) ? data.retrievalProfiles : [];
  if (profiles.length > 0) return data;

  const fallback = await request('/api/admin/retrieval-profiles').catch(() => ({ values: [] }));
  return {
    ...data,
    retrievalProfiles: Array.isArray(fallback.values) ? fallback.values : [],
  };
}

export function collectMediaWikiProfileConfig(root = document) {
  const select = root.querySelector('#mediawiki-default-retrieval-profile');
  return {
    defaultRetrievalProfileId: select?.value || '',
  };
}

export function renderMediaWikiProfileSelector(root, payload = {}, options = {}) {
  const i18n = options.i18n || {};
  const profiles = Array.isArray(payload.retrievalProfiles) ? payload.retrievalProfiles : [];
  const selectedId = payload.values?.defaultRetrievalProfileId
    || payload.selectedProfile?.id
    || options.defaultProfileId
    || 'opensearch_hybrid_colbert';
  const selectedProfile = payload.selectedProfile
    || profiles.find((profile) => profile.id === selectedId)
    || null;
  const effectiveConfig = payload.effectiveConfig || selectedProfile?.config || {};

  root.innerHTML = '';

  if (profiles.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'ai-admin-status-error';
    empty.textContent = helperText(
      i18n,
      'aiadmin-status-mediawiki-profile-empty',
      'Retrieval profiles are not loaded'
    );
    root.appendChild(empty);
    appendMediaWikiProfileActions(root, i18n, { includeRestore: true });
    return { select: null, selectedProfile: null };
  }

  const hasOpenSearchProfile = profiles.some(isOpenSearchProfile);
  const row = document.createElement('div');
  row.className = 'ai-admin-row';
  const label = document.createElement('label');
  label.htmlFor = 'mediawiki-default-retrieval-profile';
  label.textContent = helperText(i18n, 'aiadmin-field-mediawiki-retrieval-profile');
  const select = document.createElement('select');
  select.id = 'mediawiki-default-retrieval-profile';
  profiles.forEach((profile) => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = mediaWikiProfileLabel(i18n, profile);
    select.appendChild(option);
  });
  select.value = selectedId;
  row.append(label, select);
  root.appendChild(row);

  if (!hasOpenSearchProfile) {
    const warning = document.createElement('p');
    warning.className = 'ai-admin-status-warning';
    warning.textContent = helperText(
      i18n,
      'aiadmin-status-mediawiki-opensearch-profiles-missing',
      'OpenSearch retrieval profiles are not loaded'
    );
    root.appendChild(warning);
  }

  if (!selectedProfile) {
    const missing = document.createElement('p');
    missing.className = 'ai-admin-status-error';
    missing.textContent = helperText(i18n, 'aiadmin-status-mediawiki-profile-missing');
    root.appendChild(missing);
    appendMediaWikiProfileActions(root, i18n, { includeRestore: !hasOpenSearchProfile });
    return { select, selectedProfile: null };
  }

  const readiness = selectedProfile.readiness || {};
  const status = document.createElement('div');
  status.className = readiness.status === 'prod_ready'
    ? 'ai-admin-status-ok'
    : readiness.status === 'limited_ready' ? 'ai-admin-status-warning' : 'ai-admin-status-error';
  status.textContent = helperFormatText(i18n, 'aiadmin-status-mediawiki-profile-readiness', {
    status: readiness.status || helperUnknown(i18n),
    reasons: (readiness.reasons || []).join('; ') || helperText(i18n, 'aiadmin-value-none'),
  });
  root.appendChild(status);

  const config = {
    ...(selectedProfile.config || {}),
    ...(effectiveConfig || {}),
  };
  const table = document.createElement('table');
  table.className = 'ai-admin-table';
  table.innerHTML = `<thead><tr><th>${helperText(i18n, 'aiadmin-table-setting')}</th><th>${helperText(i18n, 'aiadmin-table-value')}</th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody');
  [
    [helperText(i18n, 'aiadmin-field-name'), `${selectedProfile.name} (${selectedProfile.id})`],
    [helperText(i18n, 'aiadmin-field-search-mode'), config.searchMode || 'hybrid'],
    [helperText(i18n, 'aiadmin-field-lexical-backend', 'Lexical backend'), mediaWikiLexicalBackendLabel(i18n, config.lexicalBackend || 'sqlite_fts')],
    [helperText(i18n, 'aiadmin-field-rerank-mode'), config.rerankMode || 'none'],
    [helperText(i18n, 'aiadmin-field-retrieval-top-k', 'Retrieval top-k'), config.retrievalTopK ?? config.topK ?? helperUnknown(i18n)],
    [helperText(i18n, 'aiadmin-field-context-top-k', 'Context top-k'), config.contextTopK ?? config.maxContextChunks ?? helperUnknown(i18n)],
    [helperText(i18n, 'aiadmin-field-context-max-chars', 'Context max chars'), config.contextMaxChars ?? config.maxContextChars ?? helperUnknown(i18n)],
    [helperText(i18n, 'aiadmin-field-chat-retrieval-query-mode', 'Chat retrieval history'), mediaWikiChatRetrievalModeLabel(i18n, config.chatRetrievalQueryMode)],
    ['ColBERT', helperYesNo(i18n, config.colbertEnabled)],
    [helperText(i18n, 'aiadmin-field-lexical-edit-distance-enabled'), helperYesNo(i18n, config.lexicalEditDistanceEnabled)],
    [helperText(i18n, 'aiadmin-field-trigram-index-enabled'), helperYesNo(i18n, config.trigramIndexEnabled)],
    [helperText(i18n, 'aiadmin-field-semantic-facts-in-context'), helperYesNo(i18n, config.semanticFactsInContext !== false)],
    [helperText(i18n, 'aiadmin-field-include-attachments'), helperYesNo(i18n, config.includeAttachments)],
    [helperText(i18n, 'aiadmin-field-include-semantic-header'), helperYesNo(i18n, config.includeSemanticHeader !== false)],
    [helperText(i18n, 'aiadmin-field-required-index-targets', 'Required index targets'), (readiness.requiredIndexTargets || []).join(', ') || helperText(i18n, 'aiadmin-value-none')],
    [helperText(i18n, 'aiadmin-field-missing-index-targets', 'Missing index targets'), (readiness.missingIndexTargets || []).join(', ') || helperText(i18n, 'aiadmin-value-none')],
  ].forEach(([name, value]) => {
    const tableRow = document.createElement('tr');
    appendMediaWikiTableCell(tableRow, name);
    appendMediaWikiTableCell(tableRow, value);
    tbody.appendChild(tableRow);
  });
  root.appendChild(table);
  appendMediaWikiProfileActions(root, i18n, { includeRestore: !hasOpenSearchProfile });
  return { select, selectedProfile };
}

export const DOCUMENT_CAPABILITY_GROUPS = [
  {
    id: 'office',
    titleKey: 'aiadmin-doc-cap-office-title',
    descriptionKey: 'aiadmin-doc-cap-office-description',
    items: [
      { extension: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      { extension: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { extension: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
      { extension: 'odt', mime: 'application/vnd.oasis.opendocument.text' },
      { extension: 'ods', mime: 'application/vnd.oasis.opendocument.spreadsheet' },
      { extension: 'odp', mime: 'application/vnd.oasis.opendocument.presentation' },
    ],
  },
  {
    id: 'archive',
    titleKey: 'aiadmin-doc-cap-archive-title',
    descriptionKey: 'aiadmin-doc-cap-archive-description',
    items: [
      { extension: 'zip', mime: 'application/zip' },
      { extension: 'zip', mime: 'application/x-zip-compressed' },
      { extension: '7z', mime: 'application/x-7z-compressed' },
    ],
  },
  {
    id: 'media',
    titleKey: 'aiadmin-doc-cap-media-title',
    descriptionKey: 'aiadmin-doc-cap-media-description',
    items: [
      { extension: 'mp3', mime: 'audio/mpeg' },
      { extension: 'mp3', mime: 'audio/mp3' },
      { extension: 'wav', mime: 'audio/wav' },
      { extension: 'wav', mime: 'audio/x-wav' },
      { extension: 'mpeg', mime: 'video/mpeg' },
    ],
  },
  {
    id: 'base',
    titleKey: 'aiadmin-doc-cap-base-title',
    descriptionKey: 'aiadmin-doc-cap-base-description',
    items: [
      { extension: 'pdf', mime: 'application/pdf' },
      { extension: 'txt', mime: 'text/plain' },
      { extension: 'png', mime: 'image/png' },
      { extension: 'jpg', mime: 'image/jpeg' },
      { extension: 'webp', mime: 'image/webp' },
    ],
  },
];

export function getDocumentCapabilitySummary(policy = {}) {
  const mimeTypes = policy?.mimeTypes && typeof policy.mimeTypes === 'object'
    ? policy.mimeTypes
    : {};

  return DOCUMENT_CAPABILITY_GROUPS.map((group) => {
    const items = group.items.map((item) => ({
      ...item,
      mode: mimeTypes[item.mime]?.mode || 'missing',
    }));
    return {
      ...group,
      items,
      modes: Array.from(new Set(items.map((item) => item.mode))),
    };
  });
}
