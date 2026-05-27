# Gonkong AIshenka

Unpacked Chrome extension for any Gonkong user profile.

## Что делает

- добавляет вкладку `AIшенька` в ряд вкладок любого профиля `https://gonkong.me/u/:id-:username`;
- забирает посты через `/api/v1.1/user/:id/posts?page=N&sort=fresh`;
- забирает комментарии через `/api/v1.1/user/:id/comments?page=N&sort=fresh`;
- сохраняет JSON с привязкой комментариев к комментируемым постам;
- хранит кэш по каждому профилю и при следующем сборе подтягивает только новые посты и комментарии;
- показывает прогресс по постам и комментариям во время API-сбора;
- отправляет компактный срез за последние 72 часа и общую выборку в Gemini;
- показывает Markdown-результат анализа прямо во вкладке.
- использует favicon Gonkong как иконку расширения.

## Установка

1. Открой `chrome://extensions`.
2. Включи Developer mode.
3. Нажми Load unpacked.
4. Выбери папку `/Users/yaroslav/gonkong-aishenka-extension`.

После этого открой профиль вида `https://gonkong.me/u/72-tjaba` или любой другой `https://gonkong.me/u/:id-:username` и нажми `AIшенька`.

Gemini API key хранится локально в `chrome.storage.local` этого расширения.
