# ТЕХНИЧЕСКОЕ ЗАДАНИЕ
## Интеграция Semantic MediaWiki (SMW) с AI: Авторазметка с онтологическими векторами

**Версия:** 1.2  
**Дата:** 2026-05-30  
**Статус:** Финальная версия для реализации  
**Распространение:** Дополнение к TZ MediaWiki AI v1.2

---

## 1. ОБЩИЕ ПОЛОЖЕНИЯ

### 1.1 Цель
Разработка модуля интеграции Semantic MediaWiki (SMW) с AI-системой, включающего:
- **Онтологические векторы** — классификация любых семантических типов по векторным онтологиям
- **Свободный выбор типов** — админ задает любые семантические свойства без ограничений
- **Обязательную векторную классификацию** — каждое свойство обязано иметь онтологический вектор
- **Авторазметку при сохранении** — AI извлекает свойства при каждом сохранении страницы
- **Итеративное уточнение** — разметка обновляется на каждом промежуточном сохранении
- **Заморозку после подтверждения** — после принятия пользователем AI больше не трогает разметку
- **Интеграцию с Visual Editor** — семантические поля доступны в VE через VEForAll

### 1.2 Концепция онтологических векторов

**Онтологический вектор** — это векторное представление (embedding) семантического типа, которое:
- Определяет "место" свойства в семантическом пространстве
- Позволяет AI понимать связи между свойствами без жесткой онтологии
- Используется для кластеризации, поиска похожих свойств, разрешения неоднозначности

```
Традиционная онтология:          Онтологические векторы:
┌─────────────────────┐         ┌─────────────────────────────┐
│ Отпуск              │         │ "Отпуск сотрудников"        │
│ ├─ Сотрудники       │         │  -> [0.23, -0.45, 0.89, ...]│
│ │  └─ 28 дней       │         │                             │
│ └─ Руководители     │         │ "Отпуск руководителей"      │
│    └─ 35 дней       │         │  -> [0.25, -0.42, 0.91, ...]│
│                     │         │                             │
│ Жесткая иерархия    │         │ Векторная близость = связь  │
│ Фиксированные типы  │         │ Свободные типы + векторы    │
└─────────────────────┘         └─────────────────────────────┘
```

### 1.3 Жизненный цикл SMW-разметки с векторами

```
┌─────────────────────────────────────────────────────────────┐
│  Жизненный цикл свойства с онтологическим вектором          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. АДМИН СОЗДАЕТ ТИП                                       │
│     │ Свойство: "Отпуск IT-специалистов"                   │
│     │ Тип: число + дни                                     │
│     │ Описание: "Длительность отпуска для IT"               │
│     │                                                       │
│     ▼ Генерация вектора                                     │
│     │ embedding = model.encode("Отпуск IT-специалистов")    │
│     │ -> [0.27, -0.41, 0.88, ...]                          │
│     │ Сохраняется в ai_smw_ontology.ontological_vector      │
│     │                                                       │
│  2. ПОЛЬЗОВАТЕЛЬ РЕДАКТИРУЕТ                                │
│     │ Пишет в VE: "IT-специалисты имеют 42 дня отпуска"   │
│     │ Сохраняет (промежуточно)                              │
│     │                                                       │
│     ▼ AI-ЭКСТРАКТОР                                         │
│     │ Извлекает: "42 дня"                                    │
│     │ Классифицирует по векторам:                           │
│     │   candidate = "отпуск IT" -> embedding                │
│     │   similarity(candidate, "Отпуск IT-специалистов") = 0.94│
│     │   similarity(candidate, "Отпуск руководителей") = 0.67│
│     │   -> Выбирает "Отпуск IT-специалистов"                │
│     │                                                       │
│  3. ПРЕДЛОЖЕНИЕ В VE                                       │
│     │ Показывает: "Отпуск IT-специалистов: 42 дня" [✨]     │
│     │ Уверенность: 94% (векторная близость)                 │
│     │                                                       │
│     ▼ ПОДТВЕРЖДЕНИЕ                                          │
│     │ Пользователь принимает -> verified                     │
│     │ Вектор фиксируется, AI больше не трогает             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. ОНТОЛОГИЧЕСКИЕ ВЕКТОРЫ

### 2.1 Структура онтологического вектора

```sql
-- Таблица онтологии с векторами
CREATE TABLE ai_smw_ontology (
    property_id INT AUTO_INCREMENT PRIMARY KEY,

    -- Идентификация
    property_name VARCHAR(255) UNIQUE NOT NULL,
    property_label VARCHAR(255), -- человекочитаемое название
    property_description TEXT,

    -- Тип данных (свободный выбор)
    data_type VARCHAR(50) NOT NULL, -- 'string', 'number', 'date', 'boolean', 'page', 'email', 'url', 'temperature', 'currency', etc.
    data_format VARCHAR(255), -- regex или шаблон для валидации
    unit_of_measure VARCHAR(50), -- 'дни', 'рубли', 'градусы', 'шт'

    -- Онтологический вектор (ОБЯЗАТЕЛЬНО)
    ontological_vector JSON NOT NULL, -- [0.23, -0.45, 0.89, ...] размерность 768-1536
    vector_model VARCHAR(100), -- 'text-embedding-3-large', 'e5-large', etc.
    vector_dimension INT, -- 768, 1024, 1536
    vector_generated_at TIMESTAMP,

    -- Векторные связи (вычисляемые)
    parent_properties JSON, -- [{property_id, similarity_score}, ...]
    sibling_properties JSON, -- [{property_id, similarity_score}, ...]
    child_properties JSON, -- [{property_id, similarity_score}, ...]

    -- Правила AI-извлечения
    ai_extractable BOOLEAN DEFAULT TRUE,
    ai_prompt_hint TEXT, -- подсказка для LLM: "Извлекай длительность отпуска в днях"
    extraction_patterns JSON, -- ['\d+ дней', '\d+ дня', 'отпуск .* (\d+)']

    -- Контроль доступа
    required_right VARCHAR(50), -- право для видимости ('ai-smw-use', 'sysop', etc.)
    sensitive BOOLEAN DEFAULT FALSE,

    -- Метаданные
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### 2.2 Генерация вектора при создании типа

```
Админ создает новое свойство в UI:

┌─────────────────────────────────────────────────────────────┐
│  Новое семантическое свойство                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Системное имя: [Отпуск_ИТ_специалистов________________]   │
│  Отображаемое имя: [Отпуск IT-специалистов_______________] │
│  Описание: [Длительность отпуска для IT-отдела___________]│
│                                                             │
│  Тип данных: [Число ▼]                                     │
│  Формат: [\d+ дней____________] (regex)                    │
│  Единица измерения: [дней ▼]                               │
│                                                             │
│  ─── Онтологический вектор (ОБЯЗАТЕЛЬНО) ───               │
│                                                             │
│  [🔄 Сгенерировать вектор]                                  │
│                                                             │
│  Вектор: [0.23, -0.45, 0.89, 0.12, -0.67, ...] (768 dim)  │
│  Модель: text-embedding-3-large                             │
│  Сгенерирован: 2024-05-30 14:30                             │
│                                                             │
│  🔍 Векторные связи (авто):                                │
│  ├─ Родительские: "Отпуск сотрудников" (0.91)              │
│  ├─ Соседние: "Отпуск руководителей" (0.87), "Отпуск" (0.85)│
│  └─ Дочерние: (нет)                                        │
│                                                             │
│  ─── Правила AI-извлечения ───                             │
│                                                             │
│  [x] Разрешить AI извлекать это свойство                   │
│  Подсказка для AI: [Извлекай длительность отпуска IT...__]│
│  Паттерны извлечения: ['\d+ дней', 'отпуск .* (\d+)']    │
│                                                             │
│  [💾 Сохранить свойство]                                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 Классификация при AI-извлечении

```python
Функция classifyProperty(extracted_text, candidate_value, ontology):

    // 1. Генерируем вектор для извлеченного фрагмента
    candidate_vector = embedding_model.encode(extracted_text)

    // 2. Сравниваем со всеми свойствами онтологии
    scores = []
    for prop in ontology:
        similarity = cosine_similarity(candidate_vector, prop.ontological_vector)
        scores.append({
            property: prop.property_name,
            similarity: similarity,
            threshold: prop.classification_threshold || 0.70
        })

    // 3. Сортируем по близости
    scores.sort(by: similarity, desc: true)

    // 4. Возвращаем топ-N с проходом порога
    top_matches = scores.filter(s -> s.similarity >= s.threshold)

    return {
        best_match: top_matches[0] if top_matches else null,
        alternatives: top_matches[1:3],
        confidence: top_matches[0].similarity if top_matches else 0
    }
```

### 2.4 Пример классификации в промпте

```
Ты — экстрактор семантических свойств с векторной классификацией.

ОНТОЛОГИЯ (свойства и их векторные описания):
{ontology_with_vectors}

ПРАВИЛА КЛАССИФИКАЦИИ:
1. Для каждого извлеченного факта сгенерируй векторное описание
2. Сравни с векторами свойств из онтологии (косинусная близость)
3. Выбери свойство с близостью >= 0.70
4. Если близость < 0.70 — пометь как "uncertain", предложи админу
5. Если несколько свойств близки — предложи альтернативы

ФОРМАТ ОТВЕТА:
{
  "extractions": [
    {
      "text_fragment": "фрагмент текста",
      "proposed_property": "Имя свойства из онтологии",
      "value": "извлеченное значение",
      "vector_similarity": 0.94,
      "confidence": "high" | "medium" | "low",
      "alternatives": [
        {"property": "альтернатива", "similarity": 0.82}
      ]
    }
  ]
}

ТЕКСТ:
{text}
```

---

## 3. ФУНКЦИОНАЛЬНЫЕ БЛОКИ

### 3.1 Блок A: Управление онтологией (Admin UI)

#### A.1 Вкладка "Онтологические векторы"

```
┌─────────────────────────────────────────────────────────────┐
│  AI Knowledge Management — Онтологические векторы             │
├─────────────────────────────────────────────────────────────┤
│  [Свойства] [Векторная карта] [Кластеры] [Импорт/Экспорт] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  📊 Статистика онтологии                                    │
│  ├─ Всего свойств: 47                                      │
│  ├─ С векторами: 47 (100%) — ✅ Все классифицированы       │
│  ├─ Кластеров: 8                                           │
│  └─ Свойств без связей: 3 (требуют внимания)               │
│                                                             │
│  🔍 Векторная карта (2D-визуализация t-SNE)                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                                                     │   │
│  │    ● Отпуск сотрудников                             │   │
│  │      ● Отпуск руководителей                         │   │
│  │        ● Отпуск IT-специалистов  ← новое            │   │
│  │                                                     │   │
│  │    ● Рабочий день                                   │   │
│  │      ● График работы                                │   │
│  │                                                     │   │
│  │    ● Зарплата  ⚠️ изолировано (нет связей)          │   │
│  │                                                     │   │
│  │    [🔍 Увеличить] [🎨 Перекрасить по кластерам]    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  📋 Свойства без векторных связей                           │
│  ├─ Зарплата — нет близких соседей (порог 0.70)            │
│  │   [🔍 Найти похожие вручную] [🔄 Перегенерировать вектор]│
│  └─ ...                                                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### A.2 Кластеризация свойств

```
┌─────────────────────────────────────────────────────────────┐
│  Кластеры онтологических векторов                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Кластер 1: "Отпуска и льготы" (7 свойств)                  │
│  ├─ Отпуск сотрудников -> [вектор] -> centroid            │
│  ├─ Отпуск руководителей -> [вектор] -> 0.91 к centroid   │
│  ├─ Отпуск IT-специалистов -> [вектор] -> 0.87 к centroid  │
│  ├─ Компенсация проезда -> [вектор] -> 0.72 к centroid    │
│  └─ ...                                                    │
│  [📐 Пересчитать centroid] [🔄 Перекластеризовать]          │
│                                                             │
│  Кластер 2: "Рабочее время" (5 свойств)                     │
│  ├─ Рабочий день -> [вектор] -> centroid                   │
│  ├─ График работы -> [вектор] -> 0.89 к centroid           │
│  └─ ...                                                    │
│                                                             │
│  [➕ Добавить свойство в кластер] [✏️ Переименовать]       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

### 3.2 Блок B: AI-авторазметка с векторной классификацией

#### B.1 Обновленный алгоритм экстракции

```python
Функция autoAnnotateWithVectors(page_id, text, verified_properties):

    // 1. Загружаем онтологию (только с векторами)
    ontology = getOntologyWithVectors()

    // 2. LLM извлекает кандидатов из текста
    candidates = llm_extract_candidates(text, ontology.ai_prompt_hints)

    // 3. Векторная классификация каждого кандидата
    classified = []
    for candidate in candidates:
        candidate_vector = embedding_model.encode(candidate.text_fragment)

        // Сравнение со всеми свойствами онтологии
        best_match = null
        best_similarity = 0

        for prop in ontology:
            sim = cosine_similarity(candidate_vector, prop.ontological_vector)
            if sim > best_similarity and sim >= 0.70:
                best_similarity = sim
                best_match = prop

        if best_match:
            classified.append({
                property: best_match.property_name,
                value: candidate.value,
                confidence: best_similarity,
                vector: candidate_vector.tolist(),
                alternatives: getTop3Similar(candidate_vector, ontology, exclude=best_match)
            })
        else:
            classified.append({
                property: "UNCERTAIN",
                value: candidate.value,
                confidence: best_similarity,
                vector: candidate_vector.tolist(),
                suggestion: "Требует ручного назначения свойства"
            })

    // 4. Фильтрация verified (не трогаем)
    new_properties = classified.filter(c -> c.property not in verified_properties)

    // 5. Сохранение
    saveDraft(page_id, new_properties)

    return new_properties
```

#### B.2 UI предложений в VE (с векторной уверенностью)

```
┌─────────────────────────────────────────────────────────────┐
│  Семантические поля (VEForAll) — Векторная классификация   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  🔒 Замороженные (verified):                                │
│  ├─ Отпуск сотрудников: 28 дней [🔒]                      │
│  └─ Отпуск руководителей: 35 дней [🔒]                     │
│                                                             │
│  ✨ Предложенные (AI + векторная классификация):            │
│  ├─ Отпуск IT-специалистов: 42 дня [✨]                    │
│  │   Векторная близость: 0.94 (высокая)                    │
│  │   Альтернативы: "Отпуск руководителей" (0.67) — далеко │
│  │   [✅ Принять] [✏️ Изменить] [❌ Отклонить]             │
│  │                                                         │
│  ├─ Срок согласования: 2 недели [✨]                       │
│  │   Векторная близость: 0.71 (средняя)                    │
│  │   ⚠️ Похоже на: "Срок уведомления" (0.69)             │
│  │   [✅ Принять] [✏️ Изменить] [❌ Отклонить] [🔍 Сравнить]│
│  │                                                         │
│  └─ ??? : компенсация проезда [❓]                          │
│      Векторная близость: 0.45 (ниже порога 0.70)           │
│      ⚠️ Не классифицировано — требует создания свойства    │
│      [➕ Создать новое свойство] [❌ Пропустить]           │
│                                                             │
│  [✅ Принять все классифицированные] [📝 Сохранить черновик]│
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

### 3.3 Блок C: Создание свойства из неопределенности

#### C.1 Когда AI не может классифицировать

```
AI извлек факт: "компенсация проезда" = "да"
Векторная близость со всеми свойствами < 0.70

┌─────────────────────────────────────────────────────────────┐
│  Создание нового семантического свойства                    │
│  (из неопределенной AI-извлечения)                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  AI извлек факт, но не смог классифицировать:               │
│  Текст: "компенсация проезда"                              │
│  Значение: "да"                                            │
│                                                             │
│  ─── Предложение AI ───                                    │
│                                                             │
│  Системное имя: [Компенсация_проезда________________]      │
│  (предложено AI на основе текста)                          │
│                                                             │
│  Отображаемое имя: [Компенсация проезда________________]   │
│  Описание: [Компенсация расходов на проезд до места...___] │
│                                                             │
│  Тип данных: [Булево ▼] (предложено AI: "да"/"нет")      │
│                                                             │
│  [🔄 Сгенерировать онтологический вектор]                  │
│  Вектор: [0.12, -0.33, 0.77, ...] (768 dim)               │
│                                                             │
│  🔍 Векторные связи:                                        │
│  ├─ Близко к: "Льготы" (0.81), "Компенсации" (0.79)      │
│  └─ Кластер: "Отпуска и льготы" (предложено)               │
│                                                             │
│  [💾 Создать свойство и классифицировать]                  │
│  [✏️ Редактировать перед созданием]                        │
│  [❌ Отклонить (не создавать свойство)]                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. ТЕХНИЧЕСКАЯ РЕАЛИЗАЦИЯ

### 4.1 Обновленная схема БД

```sql
-- Таблица онтологии с векторами
CREATE TABLE ai_smw_ontology (
    property_id INT AUTO_INCREMENT PRIMARY KEY,
    property_name VARCHAR(255) UNIQUE NOT NULL,
    property_label VARCHAR(255),
    property_description TEXT,

    -- Тип данных (свободный выбор)
    data_type VARCHAR(50) NOT NULL,
    data_format VARCHAR(255),
    unit_of_measure VARCHAR(50),

    -- Онтологический вектор (ОБЯЗАТЕЛЬНО)
    ontological_vector JSON NOT NULL,
    vector_model VARCHAR(100) NOT NULL,
    vector_dimension INT NOT NULL,
    vector_generated_at TIMESTAMP,

    -- Векторные связи (вычисляемые, кэшируемые)
    parent_properties JSON,
    sibling_properties JSON,
    child_properties JSON,
    cluster_id INT,
    cluster_centroid_distance FLOAT,

    -- Правила AI
    ai_extractable BOOLEAN DEFAULT TRUE,
    ai_prompt_hint TEXT,
    extraction_patterns JSON,
    classification_threshold FLOAT DEFAULT 0.70,

    -- Права
    required_right VARCHAR(50),
    sensitive BOOLEAN DEFAULT FALSE,

    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Таблица кластеров
CREATE TABLE ai_smw_clusters (
    cluster_id INT AUTO_INCREMENT PRIMARY KEY,
    cluster_name VARCHAR(255),
    cluster_description TEXT,
    centroid_vector JSON,
    properties_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Таблица черновиков (с векторами извлечений)
CREATE TABLE ai_smw_draft (
    draft_id INT AUTO_INCREMENT PRIMARY KEY,
    page_id INT NOT NULL,
    property_name VARCHAR(255) NOT NULL,
    property_value TEXT,
    property_type VARCHAR(50),

    -- Векторная классификация
    extraction_vector JSON, -- вектор извлеченного фрагмента
    classification_similarity FLOAT, -- близость к выбранному свойству
    alternative_matches JSON, -- [{property, similarity}, ...]

    source ENUM('ai_extracted', 'user_modified', 'user_added') DEFAULT 'ai_extracted',
    status ENUM('draft', 'verified', 'unlocked', 'rejected') DEFAULT 'draft',

    ai_confidence INT,
    ai_model VARCHAR(100),
    source_text VARCHAR(500),
    extracted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    verified_at TIMESTAMP NULL,
    verified_by VARCHAR(255),
    verification_comment TEXT,

    frozen_at TIMESTAMP NULL,
    frozen_by VARCHAR(255),
    unlocked_at TIMESTAMP NULL,
    unlocked_by VARCHAR(255),
    unlock_reason TEXT,

    FOREIGN KEY (page_id) REFERENCES page(page_id) ON DELETE CASCADE,
    UNIQUE KEY unique_property_per_page (page_id, property_name, status)
);

-- Индексы для векторного поиска (если БД поддерживает)
-- CREATE INDEX idx_ontology_vector ON ai_smw_ontology USING ivfflat (ontological_vector vector_cosine_ops);
```

### 4.2 API Endpoints (дополнение)

```
# Ontology vectors
GET  /api/admin/smw/ontology/vectors
POST /api/admin/smw/ontology/{property_id}/generate-vector
GET  /api/admin/smw/ontology/{property_id}/similarities
POST /api/admin/smw/ontology/clusterize

# Classification
POST /api/smw/classify
  Body: { text_fragment: string }
  Response: {
    matches: [{property, similarity, threshold}, ...],
    best_match: {property, similarity},
    alternatives: [{property, similarity}]
  }

# Vector map visualization
GET  /api/admin/smw/vector-map?dimensions=2&algorithm=tsne
  Response: { points: [{x, y, property, cluster_id}, ...] }
```

### 4.3 Права доступа (дополнение)

| Право | Описание | Default |
|-------|----------|---------|
| `ai-smw-ontology-manage` | Управление онтологией и векторами | Bureaucrat ✓ |
| `ai-smw-vector-generate` | Генерация онтологических векторов | Sysop ✓ |
| `ai-smw-cluster-manage` | Управление кластерами | Sysop ✓ |

---

## 5. ЭТАПЫ РЕАЛИЗАЦИИ

### Этап 1: Векторная инфраструктура (1 неделя)
- [ ] Интеграция embedding-модели (text-embedding-3-large / e5 / local)
- [ ] Поле ontological_vector в ai_smw_ontology
- [ ] API генерации векторов для свойств
- [ ] Косинусная близость для классификации

### Этап 2: Онтологический UI (1 неделя)
- [ ] Вкладка "Онтологические векторы" в админке
- [ ] 2D-визуализация (t-SNE/UMAP)
- [ ] Кластеризация и управление кластерами
- [ ] Обнаружение изолированных свойств

### Этап 3: AI-экстрактор с векторами (1 неделя)
- [ ] Обновленный промпт с векторной классификацией
- [ ] Классификация извлеченных фрагментов по векторам
- [ ] Обработка uncertain (близость < 0.70)
- [ ] UI создания свойства из неопределенности

### Этап 4: Интеграция с VE (1 неделя)
- [ ] Отображение векторной уверенности в VEForAll
- [ ] Альтернативы при низкой близости
- [ ] Кнопка "Сравнить с похожими свойствами"

---

*ТЗ v1.2: Добавлены онтологические векторы — свободный выбор семантических типов с обязательной векторной классификацией. AI классифицирует извлеченные факты по векторной близости, админ управляет онтологией через векторную карту.*
