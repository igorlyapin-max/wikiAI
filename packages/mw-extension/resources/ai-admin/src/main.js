import { initializeAIAdmin } from './adminApp.js';

const config = window.mw?.config?.get?.('wgAIAssistantAdminConfig') ?? window.__wikiAIAdminConfig;

if (config) {
  initializeAIAdmin(config);
}
