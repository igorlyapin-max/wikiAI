#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { COMMON_ORDERS, CORPORATE_DEPARTMENTS } from './corporate-content-fixtures.mjs';

const container = process.env.MW_CONTAINER || 'mediawiki';
const maintenance = '/var/www/html/maintenance/run.php';
const user = process.env.MW_SEMANTIC_SEED_USER || 'Admin';
const summary = 'WikiAI semantic seed';
const dryRun = process.argv.includes('--dry-run');

function dockerExec(args, input = undefined) {
  return execFileSync('docker', ['exec', '-i', container, ...args], {
    encoding: 'utf8',
    input,
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
}

function getText(title) {
  try {
    return dockerExec(['php', maintenance, 'getText', '--show-private', title]);
  } catch {
    return '';
  }
}

function editPage(title, text) {
  if (dryRun) {
    console.log(`[dry-run] ${title}`);
    return;
  }

  dockerExec([
    'php',
    maintenance,
    'edit',
    '--user',
    user,
    '--summary',
    summary,
    title,
  ], text);
  console.log(`updated ${title}`);
}

function upsertPage(title, text) {
  if (getText(title).trim() === text.trim()) {
    console.log(`unchanged ${title}`);
    return;
  }
  editPage(title, `${text.trim()}\n`);
}

function ensureSemanticHeader(title, fields) {
  const current = getText(title);
  const marker = '{{Корпоративный документ';
  if (current.includes(marker)) {
    console.log(`semantic header exists ${title}`);
    return;
  }

  const header = [
    '{{Корпоративный документ',
    ...Object.entries(fields).map(([key, value]) => `|${key}=${value}`),
    '}}',
    '',
  ].join('\n');

  editPage(title, `${header}${current.trim()}\n`);
}

const propertyPages = {
  'Свойство:Департамент': '[[Has type::Text]]\n\nДепартамент-владелец корпоративного документа.',
  'Свойство:Отдел': '[[Has type::Text]]\n\nОтдел или функция, владеющая документом.',
  'Свойство:Тип документа': '[[Has type::Text]]\n\nТип корпоративного документа: регламент, инструкция, FAQ или приказ.',
  'Свойство:Владелец процесса': '[[Has type::Text]]\n\nРоль или должность владельца процесса.',
  'Свойство:Статус документа': '[[Has type::Text]]\n\nСтатус жизненного цикла документа.',
  'Свойство:Система': '[[Has type::Text]]\n\nИнформационная система или область, к которой относится документ.',
  'Свойство:Процесс': '[[Has type::Text]]\n\nБизнес-процесс, описанный документом.',
  'Свойство:Дата действия': '[[Has type::Date]]\n\nДата вступления документа в действие.',
  'Свойство:Критичность': '[[Has type::Text]]\n\nКритичность документа для операций и доступа.',
};

const templatePage = `
<noinclude>
Шаблон семантической карточки корпоративного документа.
</noinclude><includeonly>
{| class="wikitable"
! Департамент
| [[Департамент::{{{Департамент|}}}]]
|-
! Отдел
| [[Отдел::{{{Отдел|}}}]]
|-
! Тип документа
| [[Тип документа::{{{Тип документа|}}}]]
|-
! Владелец процесса
| [[Владелец процесса::{{{Владелец процесса|}}}]]
|-
! Статус
| [[Статус документа::{{{Статус документа|Действует}}}]]
|-
! Система
| [[Система::{{{Система|}}}]]
|-
! Процесс
| [[Процесс::{{{Процесс|}}}]]
|-
! Дата действия
| [[Дата действия::{{{Дата действия|2026-05-31}}}]]
|-
! Критичность
| [[Критичность::{{{Критичность|Средняя}}}]]
|}
[[Категория:Корпоративные документы]]
</includeonly>
`;

const wikiAiSemanticTemplatePage = `
<noinclude>
Managed semantic block template for WikiAI-generated SMW facts. User semantic
facts should live outside the WikiAI managed block and are not overwritten by
the autofill service.
</noinclude><includeonly>
{| class="wikitable"
! Департамент
| [[Департамент::{{{Департамент|}}}]]
|-
! Отдел
| [[Отдел::{{{Отдел|}}}]]
|-
! Тип документа
| [[Тип документа::{{{Тип документа|}}}]]
|-
! Владелец процесса
| [[Владелец процесса::{{{Владелец процесса|}}}]]
|-
! Статус
| [[Статус документа::{{{Статус документа|}}}]]
|-
! Система
| [[Система::{{{Система|}}}]]
|-
! Процесс
| [[Процесс::{{{Процесс|}}}]]
|-
! Дата действия
| [[Дата действия::{{{Дата действия|}}}]]
|-
! Критичность
| [[Критичность::{{{Критичность|}}}]]
|}
</includeonly>
`;

function formPage(kind) {
  return `
<noinclude>
Форма создания и редактирования документа типа "${kind}".
</noinclude><includeonly>
{{{for template|Корпоративный документ}}}
{| class="formtable"
! Департамент:
| {{{field|Департамент|input type=text|mandatory}}}
|-
! Отдел:
| {{{field|Отдел|input type=text|mandatory}}}
|-
! Тип документа:
| {{{field|Тип документа|input type=text|default=${kind}|mandatory}}}
|-
! Владелец процесса:
| {{{field|Владелец процесса|input type=text}}}
|-
! Статус документа:
| {{{field|Статус документа|input type=dropdown|values=Черновик,Действует,На пересмотре,Архив|default=Действует}}}
|-
! Система:
| {{{field|Система|input type=text}}}
|-
! Процесс:
| {{{field|Процесс|input type=text}}}
|-
! Дата действия:
| {{{field|Дата действия|input type=date}}}
|-
! Критичность:
| {{{field|Критичность|input type=dropdown|values=Низкая,Средняя,Высокая,Критичная|default=Средняя}}}
|}
{{{end template}}}

'''Содержание'''

{{{standard input|free text|editor=visualeditor|rows=20}}}

{{{standard input|summary}}}
{{{standard input|save}}}
{{{standard input|preview}}}
{{{standard input|cancel}}}
</includeonly>
`;
}

const navigationPage = `
= Семантическая навигация =

Центральная страница для проверки Semantic MediaWiki, Page Forms и VEForAll.

== Формы ==

* [[Form:Регламент|Форма регламента]]
* [[Form:Инструкция|Форма инструкции]]
* [[Form:FAQ|Форма FAQ]]
* [[Form:Приказ|Форма приказа]]

== Документы по департаментам ==

{{#ask: [[Категория:Корпоративные документы]]
 |?Департамент
 |?Отдел
 |?Тип документа
 |?Статус документа
 |?Критичность
 |format=table
 |limit=50
}}
`;

function inferCriticality(title, type) {
  if (/закрытый|секрет|персональн|инцидент|классификация/i.test(`${title} ${type}`)) {
    return 'Критичная';
  }
  if (/регламент|приказ|администр/i.test(type)) {
    return 'Высокая';
  }
  return 'Средняя';
}

function inferSystem(departmentShortName, sectionName, type) {
  if (/HR|персонал/i.test(departmentShortName)) return 'HR-портал';
  if (/Finance|финанс/i.test(departmentShortName)) return /бюджет/i.test(sectionName) ? 'Бюджетная модель' : 'Финансовая система';
  if (/IT|ИТ/i.test(departmentShortName)) return /безопас/i.test(sectionName) ? 'SOC' : 'Service Desk';
  if (/приказ/i.test(type)) return 'MediaWiki';
  return 'Корпоративная wiki';
}

function firstSentence(text) {
  return text.replace(/\s+/g, ' ').split(/[.!?]/)[0].trim();
}

function buildSemanticHeaders() {
  const headers = COMMON_ORDERS.map((doc) => ({
    title: doc.title,
    fields: {
      'Департамент': 'Общий корпоративный контур',
      'Отдел': 'Корпоративное управление',
      'Тип документа': 'Приказ',
      'Владелец процесса': 'Администрация',
      'Статус документа': 'Действует',
      'Система': inferSystem('Common', 'Приказы', doc.type),
      'Процесс': firstSentence(doc.process),
      'Дата действия': '2026-05-31',
      'Критичность': inferCriticality(doc.title, doc.type),
    },
  }));

  for (const department of CORPORATE_DEPARTMENTS) {
    for (const section of department.sections) {
      for (const doc of section.docs) {
        headers.push({
          title: `${department.namespace}:${section.name}/${doc.title}`,
          fields: {
            'Департамент': department.department,
            'Отдел': section.name,
            'Тип документа': doc.type,
            'Владелец процесса': section.owner,
            'Статус документа': 'Действует',
            'Система': inferSystem(department.shortName, section.name, doc.type),
            'Процесс': firstSentence(doc.process),
            'Дата действия': '2026-05-31',
            'Критичность': inferCriticality(doc.title, doc.type),
          },
        });
      }
    }
  }

  return headers;
}

for (const [title, text] of Object.entries(propertyPages)) {
  upsertPage(title, text);
}

upsertPage('Шаблон:Корпоративный документ', templatePage);
upsertPage('Шаблон:WikiAI Semantic', wikiAiSemanticTemplatePage);
upsertPage('Form:Регламент', formPage('Регламент процесса'));
upsertPage('Form:Инструкция', formPage('Инструкция'));
upsertPage('Form:FAQ', formPage('FAQ'));
upsertPage('Form:Приказ', formPage('Приказ'));
upsertPage('CorpCommon:Семантическая навигация', navigationPage);

for (const item of buildSemanticHeaders()) {
  ensureSemanticHeader(item.title, item.fields);
}

console.log(dryRun ? 'semantic seed dry-run complete' : 'semantic seed complete');
