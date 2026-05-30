<?php
namespace MediaWiki\Extension\AIAssistant;

use SpecialPage;
use MediaWiki\MediaWikiServices;

class SpecialAIAdmin extends SpecialPage
{
  public function __construct()
  {
    parent::__construct('AIAdmin', 'sysop');
  }

  public function execute($subPage): void
  {
    $this->setHeaders();
    $this->getOutput()->setPageTitle($this->msg('aiadmin-title')->text());

    if (!$this->getUser()->isAllowed('sysop')) {
      throw new \PermissionsError('sysop');
    }

    $config = $this->getConfig();
    $gatewayUrl = rtrim($config->get('AIAssistantGatewayUrl'), '/');

    // Fetch current config from Gateway
    $currentConfig = $this->fetchCurrentConfig($gatewayUrl);

    $this->getOutput()->addHTML($this->getAdminStyles());
    $this->getOutput()->addHTML($this->renderStatusDashboard($gatewayUrl));
    $this->getOutput()->addHTML($this->renderSettingsForm($gatewayUrl, $currentConfig));
    $this->getOutput()->addHTML($this->renderManagementButtons());
  }

  private function fetchCurrentConfig(string $gatewayUrl): ?array
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

  private function getAdminStyles(): string
  {
    return '<style>
      .ai-admin-card { background:#f8f9fa; border:1px solid #c8ccd1; border-radius:4px; padding:16px; margin-bottom:16px; }
      .ai-admin-card h2 { margin-top:0; font-size:1.2em; border-bottom:1px solid #c8ccd1; padding-bottom:8px; }
      .ai-form-row { display:flex; align-items:flex-start; margin-bottom:12px; gap:12px; }
      .ai-form-label { width:280px; font-weight:bold; flex-shrink:0; }
      .ai-form-field { flex:1; }
      .ai-form-field input[type="text"], .ai-form-field input[type="number"], .ai-form-field textarea, .ai-form-field select { width:100%; max-width:400px; padding:6px; font-size:14px; }
      .ai-help-text { color:#666; font-size:12px; margin-top:4px; line-height:1.4; }
      .ai-help-text code { background:#f0f0f0; padding:1px 4px; border-radius:2px; }
      .ai-status-ok { color:#059669; font-weight:bold; }
      .ai-status-error { color:#DC2626; font-weight:bold; }
      .ai-status-warn { color:#D97706; font-weight:bold; }
      .ai-wikitable { width:100%; border-collapse:collapse; }
      .ai-wikitable th, .ai-wikitable td { border:1px solid #c8ccd1; padding:8px; text-align:left; }
      .ai-wikitable th { background:#f0f4f8; }
      .ai-btn { padding:8px 16px; margin-right:8px; cursor:pointer; border-radius:4px; border:1px solid #a2a9b1; background:#f8f9fa; }
      .ai-btn:hover { background:#eaecf0; }
      .ai-btn-primary { background:#3366cc; color:#fff; border-color:#3366cc; }
      .ai-btn-primary:hover { background:#2a56b0; }
      .ai-btn-danger { background:#dc3545; color:#fff; border-color:#dc3545; }
      .ai-btn-danger:hover { background:#c82333; }
      .ai-info-box { background:#d1ecf1; border:1px solid #bee5eb; color:#0c5460; padding:12px; border-radius:4px; margin-bottom:16px; }
    </style>';
  }

  private function renderStatusDashboard(string $gatewayUrl): string
  {
    $html = '<div class="ai-admin-card">';
    $html .= '<h2>Статус системы</h2>';

    try {
      $response = \MediaWiki\Http\Http::get($gatewayUrl . '/health', ['timeout' => 5]);
      $data = $response ? json_decode($response, true) : null;
      $overall = $data['status'] ?? 'unknown';
      $checks = $data['checks'] ?? [];

      $html .= '<table class="ai-wikitable">';
      $html .= '<tr><th>Сервис</th><th>Статус</th><th>Задержка</th><th>Описание</th></tr>';

      $descriptions = [
        'qdrant' => 'Векторная база данных. Хранит эмбеддинги всех страниц вики.',
        'redis' => 'Кеш групп пользователей и истории чатов.',
        'litellm' => 'Прокси для языковых моделей. Через него идут все запросы к ИИ.',
      ];

      foreach ($checks as $name => $check) {
        $statusClass = $check['status'] === 'ok' ? 'ai-status-ok' : 'ai-status-error';
        $statusText = $check['status'] === 'ok' ? 'Работает' : 'Ошибка';
        $desc = $descriptions[$name] ?? '';
        $html .= sprintf(
          '<tr><td><strong>%s</strong></td><td class="%s">%s</td><td>%d мс</td><td>%s</td></tr>',
          htmlspecialchars($name),
          $statusClass,
          $statusText,
          $check['latencyMs'] ?? 0,
          htmlspecialchars($desc)
        );
      }
      $html .= '</table>';

      $overallClass = $overall === 'healthy' ? 'ai-status-ok' : 'ai-status-warn';
      $overallText = $overall === 'healthy' ? 'Все системы работают нормально' : 'Есть проблемы — проверьте таблицу выше';
      $html .= '<p>Общий статус: <span class="' . $overallClass . '">' . $overallText . '</span></p>';

    } catch (\Exception $e) {
      $html .= '<div class="ai-status-error">Gateway недоступен: ' . htmlspecialchars($e->getMessage()) . '</div>';
      $html .= '<p class="ai-help-text">Убедитесь, что AI Gateway запущен и URL указан верно в LocalSettings.php ($wgAIAssistantGatewayUrl).</p>';
    }

    $html .= '</div>';
    return $html;
  }

  private function renderSettingsForm(string $gatewayUrl, ?array $cfg): string
  {
    $html = '<div class="ai-admin-card">';
    $html .= '<h2>Настройки ИИ-помощника</h2>';
    $html .= '<div class="ai-info-box">Изменения вступают в силу сразу — перезапуск сервисов не требуется.</div>';

    $html .= '<form id="ai-settings-form">';

    $html .= $this->renderFormField(
      'Модель ИИ',
      'litellmModel',
      'text',
      $cfg['litellmModel'] ?? 'mistral-7b-instruct',
      'Название модели в LiteLLM. Должно совпадать с настройками в LiteLLM Proxy. Примеры: <code>mistral-7b-instruct</code>, <code>gpt-4o</code>, <code>llama-3.1-8b</code>. При смене модели убедитесь, что она доступна в LiteLLM.',
      'Если модель недоступна — ответы перестанут генерироваться.'
    );

    $html .= $this->renderFormField(
      'Температура',
      'temperature',
      'number',
      (string)($cfg['temperature'] ?? 0.3),
      '0.1 = точные, предсказуемые ответы. 1.0 = разнообразные, но иногда непредсказуемые. Для корпоративной документации рекомендуется 0.2–0.4.',
      'Высокая температура может привести к выдуманным фактам.'
    );

    $html .= $this->renderFormField(
      'Максимальная длина ответа',
      'maxTokens',
      'number',
      (string)($cfg['maxTokens'] ?? 1024),
      'Сколько токенов может быть в одном ответе. 512 = короткие ответы. 2048 = подробные. Чем больше — тем дольше ждать и тем дороже запрос.',
      '1 токен ≈ 0.75 слова на русском языке.'
    );

    $html .= $this->renderFormField(
      'Количество документов в контексте (top-k)',
      'topK',
      'number',
      (string)($cfg['topK'] ?? 4),
      'Сколько фрагментов вики ИИ видит перед ответом. 2–3 = быстро и дёшево, но может не хватить контекста. 5–8 = точнее, но дороже. Рекомендуется 3–5.',
      'Каждый дополнительный фрагмент увеличивает стоимость запроса.'
    );

    $html .= $this->renderFormField(
      'Размер фрагмента при индексации',
      'chunkSize',
      'number',
      (string)($cfg['chunkSize'] ?? 512),
      'На сколько частей делится каждая страница при индексации. 256 = мелкие фрагменты, точный поиск. 1024 = крупные, меньше записей. Изменение требует полной переиндексации.',
      'Меньше = точнее, но медленнее индексация.'
    );

    $html .= $this->renderFormField(
      'Перекрытие фрагментов',
      'chunkOverlap',
      'number',
      (string)($cfg['chunkOverlap'] ?? 50),
      'Сколько слов дублируется между соседними фрагментами. Нужно, чтобы смысл не терялся на границах. 0 = нет перекрытия (риск потери контекста). 100 = хорошая защита, но больше дублирования. Изменение требует полной переиндексации.',
      'Рекомендуется 10% от размера фрагмента.'
    );

    $html .= $this->renderFormField(
      'Показывать источники',
      'showSources',
      'select',
      ($cfg['showSources'] ?? true) ? 'true' : 'false',
      'Если включено — в конце каждого ответа будет список страниц вики, на которых основан ответ. Помогает проверить информацию.',
      '',
      ['true' => 'Да, показывать', 'false' => 'Нет, скрыть']
    );

    $html .= $this->renderFormField(
      'Таймаут ИИ (миллисекунды)',
      'timeoutMs',
      'number',
      (string)($cfg['timeoutMs'] ?? 30000),
      'Сколько ждать ответа от модели. 15000 = 15 секунд. 60000 = 1 минута. Если модель перегружена — увеличьте.',
      'При превышении пользователь увидит ошибку.'
    );

    $html .= '<div style="margin-top:16px;">';
    $html .= '<button type="button" class="ai-btn ai-btn-primary" onclick="aiSaveSettings()">Сохранить настройки</button>';
    $html .= '<button type="button" class="ai-btn" onclick="aiResetSettings()">Сбросить по умолчанию</button>';
    $html .= '</div>';

    $html .= '</form>';
    $html .= '<div id="ai-settings-result" style="margin-top:12px;"></div>';
    $html .= $this->getSettingsJs($gatewayUrl);
    $html .= '</div>';
    return $html;
  }

  private function renderFormField(
    string $label,
    string $name,
    string $type,
    string $value,
    string $help,
    string $warning = '',
    array $options = []
  ): string {
    $html = '<div class="ai-form-row">';
    $html .= '<div class="ai-form-label">' . htmlspecialchars($label) . '</div>';
    $html .= '<div class="ai-form-field">';

    if ($type === 'select' && !empty($options)) {
      $html .= '<select name="' . $name . '">';
      foreach ($options as $val => $optLabel) {
        $selected = $val === $value ? ' selected' : '';
        $html .= '<option value="' . htmlspecialchars($val) . '"' . $selected . '>' . htmlspecialchars($optLabel) . '</option>';
      }
      $html .= '</select>';
    } else {
      $html .= '<input type="' . $type . '" name="' . $name . '" value="' . htmlspecialchars($value) . '" />';
    }

    $html .= '<div class="ai-help-text">' . $help . '</div>';
    if ($warning) {
      $html .= '<div class="ai-help-text" style="color:#D97706;">⚠️ ' . $warning . '</div>';
    }
    $html .= '</div></div>';
    return $html;
  }

  private function renderManagementButtons(): string
  {
    $html = '<div class="ai-admin-card">';
    $html .= '<h2>Управление</h2>';

    $html .= '<div style="margin-bottom:12px;">';
    $html .= '<button class="ai-btn ai-btn-danger" onclick="if(confirm(\'Очистить кеш групп пользователей?\')) aiClearCache()">Очистить кеш групп</button>';
    $html .= '<div class="ai-help-text">Удаляет кешированные группы пользователей из Redis. Полезно, если права в MediaWiki изменились и нужно сбросить старый кеш.</div>';
    $html .= '</div>';

    $html .= '<div style="margin-bottom:12px;">';
    $html .= '<button class="ai-btn" onclick="alert(\'Переиндексация запускается через CLI: cd packages/syncer && npm run reindex\')">Полная переиндексация</button>';
    $html .= '<div class="ai-help-text">Перестроение индекса всех страниц вики. Требуется после изменения размера фрагментов или при рассинхронизации. Запускается командой на сервере.</div>';
    $html .= '</div>';

    $html .= '<div id="ai-cache-result"></div>';
    $html .= $this->getManagementJs();
    $html .= '</div>';
    return $html;
  }

  private function getSettingsJs(string $gatewayUrl): string
  {
    return '<script>
    async function aiSaveSettings() {
      const form = document.getElementById("ai-settings-form");
      const data = Object.fromEntries(new FormData(form));
      ["temperature","maxTokens","topK","chunkSize","chunkOverlap","timeoutMs"].forEach(k => {
        if (data[k]) data[k] = Number(data[k]);
      });
      if (data.showSources) data.showSources = data.showSources === "true";

      try {
        const res = await fetch("' . $gatewayUrl . '/api/admin/config", {
          method: "POST",
          headers: {"Content-Type":"application/json"},
          credentials: "same-origin",
          body: JSON.stringify(data)
        });
        const result = await res.json();
        document.getElementById("ai-settings-result").innerHTML =
          res.ok ? "<span style=\"color:green\">✓ Настройки сохранены</span>" :
                   "<span style=\"color:red\">✗ Ошибка: " + (result.error || "Неизвестно") + "</span>";
      } catch(e) {
        document.getElementById("ai-settings-result").innerHTML =
          "<span style=\"color:red\">✗ Не удалось связаться с Gateway</span>";
      }
    }

    async function aiResetSettings() {
      if (!confirm("Сбросить все настройки на значения по умолчанию?")) return;
      try {
        const res = await fetch("' . $gatewayUrl . '/api/admin/config/reset", {
          method: "POST",
          credentials: "same-origin"
        });
        document.getElementById("ai-settings-result").innerHTML =
          res.ok ? "<span style=\"color:green\">✓ Настройки сброшены. Обновите страницу.</span>" :
                   "<span style=\"color:red\">✗ Ошибка</span>";
      } catch(e) {
        document.getElementById("ai-settings-result").innerHTML =
          "<span style=\"color:red\">✗ Не удалось связаться с Gateway</span>";
      }
    }
    </script>';
  }

  private function getManagementJs(): string
  {
    $gatewayUrl = rtrim($this->getConfig()->get('AIAssistantGatewayUrl'), '/');
    return '<script>
    async function aiClearCache() {
      try {
        const res = await fetch("' . $gatewayUrl . '/api/admin/cache/clear", {
          method: "POST",
          credentials: "same-origin"
        });
        const result = await res.json();
        document.getElementById("ai-cache-result").innerHTML =
          res.ok ? "<span style=\"color:green\">✓ Кеш очищен</span>" :
                   "<span style=\"color:red\">✗ Ошибка: " + (result.error || "Неизвестно") + "</span>";
      } catch(e) {
        document.getElementById("ai-cache-result").innerHTML =
          "<span style=\"color:red\">✗ Не удалось связаться с Gateway</span>";
      }
    }
    </script>';
  }

  protected function getGroupName(): string
  {
    return 'wiki';
  }
}
