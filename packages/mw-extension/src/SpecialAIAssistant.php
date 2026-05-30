<?php
namespace MediaWiki\Extension\AIAssistant;

use SpecialPage;

class SpecialAIAssistant extends SpecialPage
{
  public function __construct()
  {
    parent::__construct('AIAssistant');
  }

  public function execute($subPage): void
  {
    $this->setHeaders();
    $this->getOutput()->setPageTitle($this->msg('aiassistant-title')->text());
    $this->getOutput()->addModules('ext.aiassistant');

    $config = $this->getConfig();
    $gatewayUrl = $config->get('AIAssistantGatewayUrl');

    $this->getOutput()->addHTML(sprintf(
      '<div id="ai-assistant-root" data-gateway-url="%s"></div>',
      htmlspecialchars($gatewayUrl, ENT_QUOTES)
    ));
  }

  protected function getGroupName(): string
  {
    return 'other';
  }
}
