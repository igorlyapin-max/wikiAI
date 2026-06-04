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
