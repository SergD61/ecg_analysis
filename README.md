# ecg_analysis (Drupal 11)

Модуль для загрузки бинарных записей ER1, потокового парсинга и предпросмотра ЭКГ.

## Основные страницы
- Загрузка и список: `/admin/ecg/upload-raw`
- Отчёт: `/admin/ecg/report/{fid}`

## Кратко о реализации
- Загрузка — обычный `<input type="file">`, сервер сам переносит файл в `public://ecg_raw/` и создаёт File-entity.
- Антидубликат — md5 + size.
- Отчёт — потоковый парсинг int16 LE, без больших массивов; предпросмотр страницами записей ЭКГ по одной минуте на canvas.

## Файлы
- Контроллер: `src/Controller/EcgReportController.php`
- Форма: `src/Form/EcgRawUploadForm.php`
- Хуки: `ecg_analysis.module`
- Роуты/меню/библиотеки: `ecg_analysis.routing.yml`, `ecg_analysis.links.menu.yml`, `ecg_analysis.libraries.yml`, `ecg_analysis.info.yml`
- Шаблон: `templates/ecg-report.html.twig`
- Статические ресурсы: `js/ecg_viewer.js`, `css/ecg_style.css`

## Требования
Drupal 11.x, PHP 8.3+

## Установка
1. Скопировать модуль в `modules/custom/ecg_analysis`.
2. Включить модуль

