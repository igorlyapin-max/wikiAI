<?php
namespace MediaWiki\Extension\AIAssistant;

class AdminConfigHelper
{
  public static function fetchCurrentConfig(string $gatewayUrl): ?array
  {
    try {
      $response = \MediaWiki\Http\Http::get($gatewayUrl . '/api/admin/config', ['timeout' => 5]);
      if (!$response) return null;
      $data = json_decode($response, true);
      return $data['values'] ?? null;
    } catch (\Exception $e) {
      return null;
    }
  }
}
