export type AssistantEndpoint = (path: string) => string;

interface AssistantEndpointOptions {
  gatewayUrl: string;
  proxyEnabled?: boolean;
  proxyBase?: string;
  locationHref?: string;
}

export function createAssistantEndpoint({
  gatewayUrl,
  proxyEnabled = false,
  proxyBase = '',
  locationHref,
}: AssistantEndpointOptions): AssistantEndpoint {
  const normalizedGatewayUrl = gatewayUrl.replace(/\/+$/, '');

  return (path: string): string => {
    if (!proxyEnabled) {
      return `${normalizedGatewayUrl}${path}`;
    }

    const currentHref = locationHref ?? window.location.href;
    const url = new URL(proxyBase || currentHref, currentHref);
    url.searchParams.set('aiassistant-proxy', '1');
    url.searchParams.set('path', path);
    return url.toString();
  };
}
