# AGENTS.md — ThunderNotes

> Постоянные инструкции для coding-agent'ов, работающих с репозиторием ThunderNotes.
> Прочитай этот файл до планирования, изменения кода, Git-операций и публикации.
>
> Файл намеренно написан на русском языке. Имена API, сущностей кода, веток,
> commit messages и технических идентификаторов сохраняются в принятом в проекте виде.

---

## 1. Назначение файла

`AGENTS.md` — краткий operational contract проекта для coding-agent'ов.

Он должен помогать незнакомому агенту быстро понять:

- что такое ThunderNotes;
- какие свойства продукта принципиальны;
- как устроен код;
- какие границы нельзя нарушать случайно;
- как проверять изменения;
- как работать с Git и `main`;
- когда требуется остановиться и передать результат владельцу на ручную проверку.

Это не roadmap, не idea bank и не журнал исследований.
Нереализованные функции и планы на будущее сюда не добавляются.

### Самоизменение

`AGENTS.md` по умолчанию **read-only для coding-agent'ов**.

Не изменяй, не коммить и не пушь этот файл в рамках обычной
`feature` / `fix` / `refactor` задачи.

Если правило устарело или противоречит фактическому состоянию проекта:

1. укажи конкретный пункт;
2. объясни противоречие;
3. предложи точный diff;
4. остановись и дождись явного одобрения владельца.

Редактирование `AGENTS.md` допускается только по отдельной задаче,
явно посвящённой этому файлу, либо после отдельного одобрения предложенного diff.

---

## 2. Что такое ThunderNotes

ThunderNotes — лёгкое local-first расширение для Mozilla Thunderbird,
добавляющее отдельное пространство для быстрых текстовых заметок.

Основная продуктовая идея:

**Открыл → сразу начал писать → быстро нашёл позже.**

ThunderNotes существует внутри Thunderbird и должен ощущаться как естественная,
неперегруженная часть почтового клиента.

Проект не должен незаметно превращаться в универсальный knowledge base,
офисный пакет, wiki или тяжёлую систему управления знаниями вроде Notion или Obsidian.

---

## 3. Принципы продукта

### 3.1. Fast capture

Главный пользовательский путь должен оставаться коротким.

Создание заметки не должно требовать лишних обязательных шагов.
Не добавляй формы, мастера, обязательные названия или другие барьеры,
если задача может быть решена без них.

Autosave и немедленная возможность начать печатать — часть продукта,
а не случайная деталь реализации.

### 3.2. Thunderbird-native

ThunderNotes должен уважать UI, lifecycle и conventions Thunderbird.

При выборе решений предпочитай те, которые:

- естественно работают внутри Thunderbird;
- не ломают стандартные shortcuts и ожидания пользователя;
- корректно реагируют на тему и язык интерфейса;
- не требуют отдельного приложения для базовой работы.

### 3.3. Local-first

Базовая работа ThunderNotes должна оставаться полностью доступной локально.

По умолчанию проект не требует:

- аккаунта ThunderNotes;
- собственного облака;
- собственного backend;
- постоянного подключения к интернету.

Локальные данные пользователя являются первичной рабочей копией.

### 3.4. Явные границы данных

Пользователь должен понимать, где находятся его данные и что с ними происходит.

Не добавляй скрытые:

- сетевые запросы;
- telemetry;
- analytics;
- crash reporting;
- remote assets;
- CDN;
- runtime-загрузку исполняемого кода.

Любое изменение этой модели требует отдельного явного решения владельца.

### 3.5. Простота важнее количества функций

Не добавляй сложность только потому, что она технически возможна.

Предпочитай:

- небольшие изменения;
- понятные abstraction boundaries;
- минимум dependencies;
- предсказуемое поведение;
- лёгкий интерфейс;
- решения, которые можно проверить.

### 3.6. Переносимость данных

Предпочитай простые, документированные и переносимые представления данных.

Markdown хранится как исходный текст.
Не вводи непрозрачные proprietary-форматы без реальной технической необходимости.

---

## 4. Текущая архитектура

Перед изменением слоя сначала изучи существующую реализацию и README.

Основные области проекта:

- `src/notes/` — модель заметки и чистая derived/query логика;
- `src/storage/` — `NotesRepository`, IndexedDB, migrations, in-memory fallback;
- `src/markdown/` — Markdown rendering и sanitizer;
- `src/theme/` — определение темы;
- `src/i18n/` — локализация и locale-aware formatting;
- `src/ui/` — store, views и wiring;
- `src/background/` — регистрация и обновление Thunderbird Space;
- `tests/` — unit/headless/regression tests;
- `scripts/` — build, test, packaging и artifact verification;
- `_locales/` — локализации;
- `assets/` — статические ресурсы.

Ключевые архитектурные свойства:

- Manifest V3;
- современный Thunderbird `spaces` API;
- IndexedDB для Note data;
- `browser.storage.local` для UI preferences;
- UI работает через repository boundary;
- Plain Text и Markdown хранят исходный текст;
- UI не использует тяжёлый framework;
- Markdown проходит strict allowlist sanitizer;
- CSP остаётся независимым уровнем защиты;
- English — default locale;
- Russian поддерживается полноценно.

Не обходи существующие abstraction boundaries без необходимости.

---

## 5. Стабильный поведенческий контракт

Если текущая задача явно не требует обратного, не регрессируй:

- autosave без кнопки Save;
- best-effort flush при смене заметки и уходе со страницы: pending autosave
  немедленно инициирует async write, но не гарантирует его завершение при
  мгновенном уничтожении page/process context;
- фокус редактора после создания заметки;
- отсутствие обязательного title;
- preview списка, вычисляемый из content;
- Plain Text и Markdown;
- Markdown Edit/Preview;
- цветовую маркировку;
- live search;
- фильтрацию;
- сортировку по Created/Updated;
- отображаемый timestamp, соответствующий активному sort field;
- корректный `visible / total` counter;
- footer внизу list pane;
- responsive layout;
- single-pane workflow на узкой ширине;
- Light/Dark UI;
- корректную Space icon для Light/Dark;
- live theme switching;
- RU/EN вслед за UI language Thunderbird;
- сохранение заметок после перезапуска Thunderbird;
- persistence UI preferences, которые уже сохраняются;
- намеренно неперсистентный search query;
- подтверждение перед удалением;
- строгую Markdown sanitization и CSP.

Если изменение затрагивает этот список:

- добавь regression coverage;
- включи поведение в manual checklist;
- не считай headless test достаточным доказательством корректности runtime.

---

## 6. Известные Thunderbird-specific инварианты

Эти правила отражают уже проверенное поведение проекта.
Не меняй их попутно в несвязанной задаче.

### Space icon

Текущая рабочая стратегия:

- не использовать `context-stroke` / `context-fill`;
- не полагаться на автоматический выбор `themeIcons`;
- эффективную тему определяет ThunderNotes;
- конкретный glyph передаётся через `defaultIcons`;
- page theme и icon selection используют общий theme-detection path.

Если требуется изменить этот механизм — сначала обоснуй причину и обязательно
предусмотри ручную проверку в реальном Thunderbird.

### I18n substitutions

Для динамических параметров предпочитай прямые positional placeholders:

`$1`, `$2`, ...

Не вводи лишний named-placeholder layer без необходимости.

### Runtime имеет высший приоритет

Если воспроизводимое поведение реального поддерживаемого Thunderbird расходится
с unit/headless test, документацией или предположением по исходникам,
runtime-факт имеет приоритет.

Не «исправляй» рабочее поведение обратно под теорию.

---

## 7. Security и privacy

### Контент

Не ослабляй текущую Markdown/security model:

- raw HTML не является пользовательской функцией;
- allowlist sanitizer обязателен;
- опасные URL schemes блокируются;
- CSP остаётся независимым защитным слоем.

Новая возможность, расширяющая допустимый контент, должна отдельно оцениваться
с точки зрения XSS и privacy.

### Permissions

Без явного согласования владельца не расширяй security surface расширения.

Особого внимания требуют изменения:

- `permissions`;
- `optional_permissions`;
- host permissions;
- `nativeMessaging`;
- experiment APIs;
- CSP;
- `connect-src`;
- внешний network access;
- произвольный filesystem access;
- новые privileged Thunderbird APIs.

Если задача этого требует, явно укажи изменение security/privacy boundary в плане.

### Пользовательские данные

Исходники проекта и реальные данные Thunderbird — разные области.

Без явного задания не ищи, не читай, не копируй и не экспортируй профиль
Thunderbird пользователя.

Не добавлять в Git:

- IndexedDB/SQLite пользователя;
- Thunderbird profile data;
- реальные экспортированные заметки;
- cookies/session data;
- credentials;
- API keys/tokens/private keys;
- `.env`;
- чувствительные дампы и логи;
- machine-specific secrets.

Persistent storage issue нельзя решать удалением пользовательской базы.

Любое изменение persistent model должно сохранять существующие данные
через безопасную migration path и иметь regression tests.

---

## 8. Dependencies и build surface

Перед добавлением dependency проверь:

1. можно ли решить задачу без неё;
2. нужна ли она в runtime;
3. размер и maintenance cost;
4. лицензию;
5. отсутствие скрытой telemetry/network behaviour;
6. совместимость с Thunderbird и текущим build.

Runtime dependency должна быть bundled в XPI.
ThunderNotes не должен скачивать исполняемый код при запуске.

Не меняй package manager или lockfile strategy как побочный эффект другой задачи.

---

## 9. Проверки проекта

Используй существующие scripts из `package.json`.
Не создавай параллельный build/test workflow без необходимости.

Базовые команды проекта:

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run verify
pnpm run xpi
```

Полный pipeline:

```bash
pnpm run package
```

Перед handoff development-задачи ожидается:

- успешный typecheck;
- успешный build;
- весь test suite без failures;
- artifact verification;
- XPI packaging, если изменение требует ручного runtime test.

Не ослабляй tests, sanitizer, CSP или verifier ради зелёной сборки.

---

## 10. Git policy

### `main` — только вручную проверенный stable

Это критическое правило.

Никогда не push/merge новую или непроверенную функциональность напрямую в `main`.

Зелёные:

- tests;
- typecheck;
- build;
- verifier;

не являются разрешением на merge.

Thunderbird runtime уже демонстрировал поведение, которое невозможно полностью
подтвердить headless-тестами.

Относись к `main` как к protected branch даже если GitHub технически
не применяет branch protection.

### Обычный workflow

Если владелец явно не сказал иначе:

1. проверь текущую branch и working tree;
2. начни от актуального стабильного `main`;
3. **до изменения файлов** создай отдельную branch;
4. реализуй только заявленный scope;
5. добавь/обнови regression tests;
6. запусти полный verification pipeline;
7. при runtime-изменениях собери XPI;
8. подготовь manual checklist;
9. сообщи branch, commit hash и artifact;
10. **STOP**;
11. дождись явного подтверждения владельца после ручной проверки;
12. merge/tag/release — только по отдельному разрешению.

Молчание не является разрешением.

Предпочтительные имена веток:

```text
feature/<short-name>
fix/<short-name>
refactor/<short-name>
docs/<short-name>
chore/<short-name>
```

---

## 11. Запрещённые Git/release действия без явного разрешения

Не выполнять самостоятельно:

- разработку непосредственно в `main`;
- push непроверенного кода в `main`;
- merge своей branch в `main`;
- force-push;
- rewrite опубликованной истории;
- удаление или перенос stable tags;
- удаление/пересоздание remote repository;
- смену repository visibility;
- создание GitHub Release;
- публикацию XPI;
- публикацию в addons.thunderbird.net.

При конфликте истории или неоднозначности остановись и сообщи владельцу.

---

## 12. Коммиты и scope discipline

Предпочтительные commit prefixes:

```text
feat:
fix:
refactor:
test:
docs:
chore:
```

Коммиты должны быть тематически цельными.

Если задача — «исправить X»:

- исправь X;
- добавь нужные regression tests;
- обнови связанную документацию;
- не реализуй попутно Y и Z.

Если обнаружена отдельная проблема, сообщи о ней отдельно.
Не расширяй scope самовольно.

---

## 13. Versioning

Не дублируй номер текущей stable-версии в этом файле.

Источники истины:

- `manifest.json`;
- `package.json`;
- Git history/tags.

Правила:

- начало feature branch не требует version bump;
- version bump выполняется при подготовке одобренного release candidate;
- stable tag создаётся только после автоматической и ручной проверки;
- опубликованный tag не переназначается;
- extension ID не менять без отдельного решения и оценки upgrade/data compatibility.

---

## 14. Manual verification gate

Если изменение затрагивает Thunderbird runtime, финальный отчёт до ручной проверки
должен содержать:

### Что изменилось
Кратко и конкретно.

### Root cause
Для bugfix — настоящая причина, если она установлена.

### Automated verification
Результаты typecheck/tests/build/verifier/package.

### Что нельзя проверить вне Thunderbird
Явный список.

### Manual checklist
Короткие воспроизводимые шаги.

### Git
Branch, commit hash, XPI path при наличии.

После этого **STOP**.
Не merge в `main`.

Реальный Thunderbird обязателен для релевантных изменений, связанных с:

- Space registration/toolbar;
- icon/theme behaviour;
- live theme switching;
- responsive geometry;
- persistence между рестартами;
- UI language/i18n;
- permissions;
- Thunderbird-specific lifecycle/events;
- системными интеграциями.

---

## 15. UI и локализация

Для новой UI-функции проверяй:

- не ухудшает ли она основной capture flow;
- Light/Dark;
- narrow layout;
- keyboard accessibility;
- `aria-label` / `title`;
- конфликты с Thunderbird shortcuts;
- hover/focus/active/disabled states.

Все новые user-facing strings проходят через `browser.i18n`.

Минимально поддерживаются:

- English;
- Russian.

Не сохраняй локализованные enum/state values в persistent data.
Локализуется представление, а не machine value.

Даты и время форматируются по UI locale Thunderbird.

---

## 16. Документация

README должен описывать фактически существующее поведение.

Не называй runtime-поведение «verified», если проверялись только:

- source;
- unit tests;
- headless DOM;
- документация/API;
- исходники Thunderbird.

Нереализованный функционал не описывай как существующий.

Hard-won runtime facts сохраняй в подходящей документации,
чтобы следующий агент не повторял уже опровергнутый подход.

---

## 17. Generated output и working tree

По умолчанию не трекать:

- `node_modules/`;
- `build/`;
- `dist/`;
- `artifacts/`;
- coverage;
- logs;
- temporary research trees;
- IDE/OS state;
- `.env`.

Не удаляй полезные локальные artifacts только потому, что они ignored.

Соблюдай существующую line-ending policy и не создавай бессмысленный CRLF/LF churn.

---

## 18. Приоритет доверия

Для runtime-вопросов:

1. воспроизводимое поведение в реальном поддерживаемом Thunderbird;
2. воспроизводимый минимальный runtime test;
3. официальный Thunderbird API contract;
4. исходники Thunderbird;
5. automated/headless tests ThunderNotes;
6. предположение агента.

Для security и сохранности данных при неопределённости выбирай более
консервативный вариант и выноси вопрос владельцу.

---

## 19. Финальное правило

ThunderNotes должен ощущаться так:

> **«Мне надо быстро записать мысль прямо в Thunderbird, и я уверен, что данные мои,
> находятся там, где я ожидаю, а приложение не делает ничего скрытого».**

Если техническое решение заметно размывает эту модель, не принимай его как
обычный implementation detail — остановись и вынеси вопрос на отдельное
архитектурное обсуждение.
