# Deployment Runbook: Semantic MediaWiki, Page Forms, VEForAll

Runbook описывает безопасное внедрение SMW/VEForAll поверх текущей MediaWiki.
Команды установки намеренно разделены на аудит, backup, dry-run и применение:
текущий контейнер `mediawiki` не содержит Composer, а `LocalSettings.php`
смонтирован извне read-only.

Официальные страницы для сверки совместимости:

- Semantic MediaWiki: https://www.mediawiki.org/wiki/Extension:Semantic_MediaWiki
- SMW install with Composer: https://www.semantic-mediawiki.org/wiki/Help:Installation/Using_Composer_with_MediaWiki_1.25%2B
- VEForAll: https://www.mediawiki.org/wiki/Extension:VEForAll
- Page Forms: https://www.mediawiki.org/wiki/Extension:Page_Forms

## 1. Read-only audit

```bash
node scripts/audit-smw-rollout.mjs
node scripts/audit-smw-rollout.mjs --json
```

Аудит не устанавливает пакеты и не меняет wiki. Он проверяет:

- версию MediaWiki/PHP;
- наличие Composer;
- наличие VisualEditor, SemanticMediaWiki, PageForms, VEForAll;
- mount `LocalSettings.php`;
- доступность MediaWiki API;
- предупреждения и блокеры rollout.

## 2. Backup перед установкой

Перед любыми изменениями сохранить:

- базу MediaWiki;
- каталог `images/`;
- внешний `LocalSettings.php`;
- текущий каталог `extensions/`;
- текущий `composer.local.json`/`composer.lock`, если они используются.

Пример для текущего стенда нужно адаптировать к фактическому имени БД и способу
запуска MariaDB/PostgreSQL:

```bash
docker exec <db-container> mysqldump -u <user> -p<password> <database> > backup/mediawiki.sql
cp /home/lsk/projects/ubuntu/mediawiki/LocalSettings.php backup/LocalSettings.php
tar -czf backup/images.tgz -C /home/lsk/projects/ubuntu/mediawiki images
docker exec mediawiki tar -czf /tmp/extensions.tgz -C /var/www/html extensions
docker cp mediawiki:/tmp/extensions.tgz backup/extensions.tgz
```

Не добавляй backup с секретами в git.

## 3. Composer strategy

Текущий контейнер не содержит Composer. Есть два безопасных варианта:

1. Собрать новый MediaWiki-образ с Composer и расширениями внутри image.
2. Использовать disposable Composer container, смонтировав MediaWiki root и
   выполняя Composer-команды с тем же PHP major/minor.

Для production-повторяемости предпочтителен новый image. Для тестового стенда
допустим disposable Composer container, если он не меняет внешние секреты.

Dry-run перед установкой:

```bash
docker exec mediawiki sh -lc 'cd /var/www/html && composer --version'
docker exec mediawiki sh -lc 'cd /var/www/html && composer require --dry-run mediawiki/semantic-media-wiki'
```

На текущем стенде первая команда ожидаемо падает, пока Composer не добавлен.

## 4. Установка расширений

Semantic MediaWiki устанавливать через Composer в корне MediaWiki:

```bash
cd /var/www/html
composer require mediawiki/semantic-media-wiki
```

На текущем стенде MediaWiki 1.45.3 стабильный `mediawiki/semantic-media-wiki`
6.0.1 создал таблицы, но упал на несовместимости `JsonContentHandler` во время
SMW import. Для тестовой проверки был использован `dev-master`, который
отображается как `SemanticMediaWiki 7.0.0-alpha`:

```json
{
  "require": {
    "mediawiki/semantic-media-wiki": "dev-master",
    "mediawiki/page-forms": "~6.0"
  }
}
```

Для production это нужно заменить на стабильный релиз SMW, когда он официально
поддержит MediaWiki 1.45.x, либо закрепить проверенный commit dev-ветки в
deployment notes.

Page Forms и VEForAll ставить из совместимых с MediaWiki 1.45 релизов или веток
по официальным инструкциям расширений. После установки каталоги должны быть:

```txt
/var/www/html/extensions/SemanticMediaWiki
/var/www/html/extensions/PageForms
/var/www/html/extensions/VEForAll
```

Если для Page Forms в выбранной версии доступна Composer-установка, использовать
ее. Если нет, фиксировать точный git tag/commit в deployment notes.

## 5. LocalSettings.php

Изменять нужно внешний файл, который смонтирован в контейнер:
`/home/lsk/projects/ubuntu/mediawiki/LocalSettings.php`.

Минимальный блок после существующих extension load calls:

```php
wfLoadExtension( 'SemanticMediaWiki' );
$smwgNamespace = 'http://127.0.0.1:8082/id/';

wfLoadExtension( 'PageForms' );
wfLoadExtension( 'VEForAll' );

$smwgNamespacesWithSemanticLinks[3000] = true;
$smwgNamespacesWithSemanticLinks[3010] = true;
$smwgNamespacesWithSemanticLinks[3020] = true;
$smwgNamespacesWithSemanticLinks[3030] = true;
```

Для production заменить `127.0.0.1:8082` на канонический wiki hostname.
В SMW 7 `enableSemantics()` deprecated и печатает warning, который ломает JSON
ответы API, если `display_errors` включен.

## 6. Maintenance

После изменения расширений выполнить update и SMW setup/rebuild по документации
установленной версии:

```bash
docker exec mediawiki php /var/www/html/maintenance/run.php update
docker exec mediawiki php /var/www/html/extensions/SemanticMediaWiki/maintenance/setupStore.php
docker exec mediawiki php /var/www/html/extensions/SemanticMediaWiki/maintenance/rebuildData.php -v
```

Если установленная версия SMW регистрирует maintenance commands через
`maintenance/run.php`, использовать соответствующую форму из справки SMW.

## 7. Semantic seed

После базовой установки добавить несколько тестовых свойств и форм:

- `Property:Департамент`
- `Property:Отдел`
- `Property:Тип документа`
- `Property:Владелец процесса`
- `Property:Статус документа`
- `Form:Регламент`
- `Form:Инструкция`
- `Form:FAQ`
- `Form:Приказ`

Контент добавлять поверх существующего корпоративного seed, сохраняя namespace и
page-level read rules.

Повторяемый seed текущего стенда:

```bash
node scripts/seed-semantic-wiki.mjs --dry-run
node scripts/seed-semantic-wiki.mjs
docker exec mediawiki php /var/www/html/maintenance/run.php /var/www/html/extensions/SemanticMediaWiki/maintenance/rebuildData.php --page 'CorpCommon:Семантическая навигация|CorpHR:Кадровое администрирование/Регламент обработки кадровых заявок|CorpFinance:Бюджетирование/Регламент план-факт анализа|CorpIT:Информационная безопасность/Регламент инцидентов ИБ|CorpCommon:Приказы/Классификация корпоративной информации' --refresh-propertystatistics --v
```

## 8. AI integration gates

До включения AI-разметки проверить:

- `node scripts/verify-corporate-acl-live.mjs` без LLM;
- полную переиндексацию Syncer с service-user credentials;
- поиск по страницам с SMW-свойствами;
- отсутствие semantic facts из закрытых страниц в результатах пользователей без
  прав;
- admin document processing policy для MIME-типов.

OpenAI/LiteLLM live extraction включать только отдельным флагом и малым набором
страниц. Базовые тесты должны проходить без платных API.

## 9. Rollback

Откат:

1. выключить traffic к AI Gateway, если идет приемка AI-интеграции;
2. убрать новые `wfLoadExtension` строки из внешнего `LocalSettings.php`;
3. восстановить backup БД, если maintenance изменил schema;
4. восстановить `extensions/` и `composer.lock`;
5. перезапустить MediaWiki;
6. проверить `api.php?action=query&meta=siteinfo`.

Не считать rollout завершенным, пока rollback не описан для фактической БД и
фактических volume текущего стенда.
