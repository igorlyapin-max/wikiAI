<?php
/**
 * Test-stand corporate content and ACL setup for WikiAI.
 *
 * Include this from LocalSettings.php after wfLoadExtension( 'AIAssistant' ).
 * It is intended for repeatable QA environments, not for production policy.
 */

define('NS_CORP_COMMON', 3000);
define('NS_CORP_COMMON_TALK', 3001);
define('NS_CORP_HR', 3010);
define('NS_CORP_HR_TALK', 3011);
define('NS_CORP_FINANCE', 3020);
define('NS_CORP_FINANCE_TALK', 3021);
define('NS_CORP_IT', 3030);
define('NS_CORP_IT_TALK', 3031);
define('NS_WIKIAI_ADMIN', 3040);
define('NS_WIKIAI_ADMIN_TALK', 3041);

$wgExtraNamespaces[NS_CORP_COMMON] = 'CorpCommon';
$wgExtraNamespaces[NS_CORP_COMMON_TALK] = 'CorpCommon_talk';
$wgExtraNamespaces[NS_CORP_HR] = 'CorpHR';
$wgExtraNamespaces[NS_CORP_HR_TALK] = 'CorpHR_talk';
$wgExtraNamespaces[NS_CORP_FINANCE] = 'CorpFinance';
$wgExtraNamespaces[NS_CORP_FINANCE_TALK] = 'CorpFinance_talk';
$wgExtraNamespaces[NS_CORP_IT] = 'CorpIT';
$wgExtraNamespaces[NS_CORP_IT_TALK] = 'CorpIT_talk';
$wgExtraNamespaces[NS_WIKIAI_ADMIN] = 'WikiAIAdmin';
$wgExtraNamespaces[NS_WIKIAI_ADMIN_TALK] = 'WikiAIAdmin_talk';

$wgContentNamespaces[] = NS_CORP_COMMON;
$wgContentNamespaces[] = NS_CORP_HR;
$wgContentNamespaces[] = NS_CORP_FINANCE;
$wgContentNamespaces[] = NS_CORP_IT;
$wgContentNamespaces[] = NS_WIKIAI_ADMIN;

$wgAvailableRights[] = 'read-corphr';
$wgAvailableRights[] = 'read-corpfinance';
$wgAvailableRights[] = 'read-corpit';
$wgAvailableRights[] = 'read-wikiaiadmin';

$wgGroupPermissions['ai-hr']['read'] = true;
$wgGroupPermissions['ai-hr']['edit'] = true;
$wgGroupPermissions['ai-hr']['createpage'] = true;
$wgGroupPermissions['ai-hr']['read-corphr'] = true;

$wgGroupPermissions['ai-finance']['read'] = true;
$wgGroupPermissions['ai-finance']['edit'] = true;
$wgGroupPermissions['ai-finance']['createpage'] = true;
$wgGroupPermissions['ai-finance']['read-corpfinance'] = true;

$wgGroupPermissions['ai-it']['read'] = true;
$wgGroupPermissions['ai-it']['edit'] = true;
$wgGroupPermissions['ai-it']['createpage'] = true;
$wgGroupPermissions['ai-it']['read-corpit'] = true;

$wgGroupPermissions['ai-exec']['read'] = true;
$wgGroupPermissions['ai-exec']['edit'] = true;
$wgGroupPermissions['ai-exec']['createpage'] = true;
$wgGroupPermissions['ai-exec']['read-corphr'] = true;
$wgGroupPermissions['ai-exec']['read-corpfinance'] = true;
$wgGroupPermissions['ai-exec']['read-corpit'] = true;
$wgGroupPermissions['ai-exec']['read-wikiaiadmin'] = true;
$wgGroupPermissions['sysop']['read-wikiaiadmin'] = true;
$wgGroupPermissions['aiadmin']['read'] = true;
$wgGroupPermissions['aiadmin']['aiadmin'] = true;
$wgGroupPermissions['aiadmin']['read-wikiaiadmin'] = true;

$wgNamespaceProtection[NS_CORP_HR] = ['read-corphr'];
$wgNamespaceProtection[NS_CORP_FINANCE] = ['read-corpfinance'];
$wgNamespaceProtection[NS_CORP_IT] = ['read-corpit'];
$wgNamespaceProtection[NS_WIKIAI_ADMIN] = ['read-wikiaiadmin'];

foreach (['ai-hr', 'ai-finance', 'ai-it', 'ai-exec', 'aiadmin'] as $aiGroup) {
    $wgAddGroups['sysop'][] = $aiGroup;
    $wgRemoveGroups['sysop'][] = $aiGroup;
}

$wgAIAssistantPageAclRules = [
    [
        'prefix' => 'WikiAIAdmin:',
        'groups' => ['sysop', 'aiadmin', 'ai-exec'],
    ],
    [
        'prefix' => 'CorpCommon:WikiAI/Администрирование',
        'groups' => ['sysop', 'aiadmin', 'ai-exec'],
    ],
    [
        'title' => 'CorpHR:Кадровое администрирование/Порядок обработки персональных данных',
        'groups' => ['ai-exec'],
    ],
    [
        'title' => 'CorpFinance:Бюджетирование/Закрытый план бюджета на квартал',
        'groups' => ['ai-exec'],
    ],
    [
        'title' => 'CorpIT:Информационная безопасность/Ротация секретов администрирования',
        'groups' => ['ai-exec'],
    ],
    [
        'prefix' => 'CorpHR:',
        'groups' => ['ai-hr', 'ai-exec'],
    ],
    [
        'prefix' => 'CorpFinance:',
        'groups' => ['ai-finance', 'ai-exec'],
    ],
    [
        'prefix' => 'CorpIT:',
        'groups' => ['ai-it', 'ai-exec'],
    ],
];
