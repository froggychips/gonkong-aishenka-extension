(() => {
  const EXTENSION_CLASS = "aishenka-extension";
  const DEFAULT_MODEL = "gemini-2.5-flash";
  const DATASET_SCHEMA = "gonkong-aishenka.v2";
  const STORAGE_KEYS = {
    apiKey: "aishenkaGeminiApiKey",
    model: "aishenkaGeminiModel",
    cachePrefix: "aishenkaProfileCache"
  };

  const state = {
    active: false,
    collecting: false,
    collected: null,
    lastPrompt: "",
    tab: null,
    panel: null,
    progress: null,
    profile: null,
    profileKey: ""
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function parseProfileFromLocation() {
    const match = location.pathname.match(/^\/u\/(\d+)(?:-([^/?#]+))?/);
    if (!match) return null;
    return {
      id: Number(match[1]),
      slug: match[2] || "",
      url: `${location.origin}/u/${match[1]}${match[2] ? `-${match[2]}` : ""}`
    };
  }

  function profileKey(profile) {
    return profile ? `${profile.id}:${profile.slug}` : "";
  }

  function cacheKey(profile) {
    return `${STORAGE_KEYS.cachePrefix}:${profile.id}:${profile.slug || "profile"}`;
  }

  function htmlToText(html) {
    if (!html) return "";
    if (typeof html === "object") return bodyToText(html);
    const template = document.createElement("template");
    template.innerHTML = String(html);
    return (template.content.textContent || "").replace(/\s+/g, " ").trim();
  }

  function mediaLabel(item) {
    const url = item?.url || item?.src || item?.href || "";
    const caption = item?.caption || item?.alt || item?.title || "";
    return [caption, url].filter(Boolean).join(" ");
  }

  function valueText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return htmlToText(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join("\n");
    if (typeof value === "object") {
      if (value.text) return htmlToText(value.text);
      if (value.caption) return htmlToText(value.caption);
      if (value.url || value.src || value.href) return mediaLabel(value);
      if (Array.isArray(value.images)) return value.images.map(mediaLabel).filter(Boolean).join("\n");
      if (Array.isArray(value.files)) return value.files.map(mediaLabel).filter(Boolean).join("\n");
      if (Array.isArray(value.items)) return value.items.map(valueText).filter(Boolean).join("\n");
      return Object.entries(value)
        .filter(([key]) => !["id", "type", "attrs", "tunes"].includes(key))
        .map(([, item]) => valueText(item))
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  function blocksToText(blocks) {
    if (!Array.isArray(blocks)) return "";
    return blocks
      .map((block) => {
        if (!block) return "";
        if (block.type && block.data) return valueText(block.data);
        return valueText(block);
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  function bodyToText(body) {
    if (!body) return "";
    if (typeof body === "string") return htmlToText(body);
    if (Array.isArray(body)) return blocksToText(body);
    if (Array.isArray(body.blocks)) return blocksToText(body.blocks);
    return valueText(body);
  }

  function firstDate(item) {
    return (
      item.date ||
      item.created_at ||
      item.createdAt ||
      item.published_at ||
      item.publishedAt ||
      item.updated_at ||
      item.updatedAt ||
      null
    );
  }

  function normalizePost(post) {
    const bodyText = bodyToText(post.body || post.text || post.content || "");
    const blocksText = blocksToText(post.blocks || post.body?.blocks);
    return {
      id: post.id,
      title: post.title || post.name || "",
      url: post.url || (post.slug ? `${location.origin}/post/${post.slug}` : ""),
      body_html: post.body || "",
      body_text: bodyText || blocksText,
      blocks_text: blocksText,
      created_at: firstDate(post),
      rating: post.rating ?? post.rate ?? post.score ?? null,
      comments_count: post.comments_count ?? post.commentsCount ?? post.comments?.count ?? null,
      channel: post.channel
        ? {
            id: post.channel.id,
            title: post.channel.title || post.channel.name || "",
            slug: post.channel.slug || ""
          }
        : null,
      tags: Array.isArray(post.tags)
        ? post.tags.map((tag) => tag.title || tag.name || tag.slug || String(tag))
        : []
    };
  }

  function normalizeComment(comment) {
    const post = comment.post ? normalizePost(comment.post) : null;
    return {
      id: comment.id,
      post_id: comment.post_id ?? comment.postId ?? post?.id ?? null,
      parent_id: comment.parent_id ?? comment.parentId ?? comment.parent_comment_id ?? null,
      url: comment.url || "",
      body_html: comment.body || "",
      body_text: bodyToText(comment.body || comment.text || comment.content || ""),
      created_at: firstDate(comment),
      rating: comment.rating ?? comment.rate ?? comment.score ?? null,
      post
    };
  }

  function extractItems(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.items)) return payload.items;
    return [];
  }

  function totalFromMeta(payload, fallback) {
    const meta = payload?.meta || {};
    return (
      Number(meta.total) ||
      Number(meta.count) ||
      Number(meta.pagination?.total) ||
      Number(meta.pagination?.count) ||
      fallback ||
      0
    );
  }

  function hasNextPage(payload, page, items) {
    if (payload?.links?.next) return true;
    const meta = payload?.meta || {};
    const last =
      Number(meta.last_page) ||
      Number(meta.lastPage) ||
      Number(meta.pagination?.last_page) ||
      Number(meta.pagination?.lastPage);
    if (last) return page < last;
    return items.length >= 25;
  }

  function endpointFor(kind, profile, page) {
    const path =
      kind === "posts"
        ? `/api/v1.1/user/${profile.id}/posts`
        : `/api/v1.1/user/${profile.id}/comments`;
    return `${location.origin}${path}?page=${page}&sort=fresh`;
  }

  function updateProgress(kind, patch) {
    if (!state.progress) return;
    const entry = state.progress[kind] || {};
    state.progress[kind] = { ...entry, ...patch };
    renderProgress();
  }

  function progressLine(label, entry) {
    const total = entry.total || 0;
    const loaded = entry.loaded || 0;
    const page = entry.page || 0;
    const percent = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    const left = total ? Math.max(0, total - loaded) : null;
    const cacheText = entry.cacheItems ? `, кэш ${entry.cacheItems}` : "";
    const newText = entry.newItems ? `, новых ${entry.newItems}` : "";
    return `
      <div class="aishenka-progress-row">
        <div class="aishenka-progress-head">
          <span>${label}</span>
          <span>${loaded}${total ? ` / ${total}` : ""}${left !== null ? `, осталось ${left}` : ""}${cacheText}${newText}</span>
        </div>
        <div class="aishenka-progress-track">
          <div class="aishenka-progress-fill" style="width: ${total ? percent : 12}%"></div>
        </div>
        <div class="aishenka-progress-foot">${entry.mode || "страница API"}: ${page || "-"}</div>
      </div>`;
  }

  function renderProgress() {
    const target = state.panel?.querySelector("[data-aishenka-progress]");
    if (!target || !state.progress) return;
    target.innerHTML = `
      ${progressLine("Посты", state.progress.posts || {})}
      ${progressLine("Комментарии", state.progress.comments || {})}
    `;
  }

  async function fetchPage(kind, profile, page) {
    const response = await fetch(endpointFor(kind, profile, page), {
      credentials: "include",
      headers: {
        Accept: "application/json"
      }
    });

    if (response.status === 429) {
      await sleep(2500);
      return fetchPage(kind, profile, page);
    }

    if (!response.ok) {
      throw new Error(`${kind}: HTTP ${response.status} on page ${page}`);
    }

    return response.json();
  }

  async function collectPaginated(kind, profile, normalizer, cachedItems = []) {
    const fetched = [];
    const cachedIds = new Set(cachedItems.map((item) => item.id).filter(Boolean));
    const countNewFetched = () => fetched.filter((item) => !cachedIds.has(item.id)).length;
    let page = 1;
    let total = 0;

    while (page < 1000) {
      const newFetchedBefore = countNewFetched();
      updateProgress(kind, {
        page,
        loaded: cachedItems.length + newFetchedBefore,
        total,
        cacheItems: cachedItems.length,
        newItems: newFetchedBefore,
        mode: cachedItems.length ? "инкрементальная страница API" : "страница API"
      });
      const payload = await fetchPage(kind, profile, page);
      const items = extractItems(payload);
      const normalized = items.map(normalizer);
      const reachedKnownPage =
        cachedIds.size > 0 &&
        normalized.length > 0 &&
        normalized.every((item) => cachedIds.has(item.id));

      total = totalFromMeta(payload, total);
      fetched.push(...normalized);
      const newFetchedAfter = countNewFetched();
      updateProgress(kind, {
        page,
        loaded: cachedItems.length + newFetchedAfter,
        total,
        cacheItems: cachedItems.length,
        newItems: newFetchedAfter,
        mode: cachedItems.length ? "инкрементальная страница API" : "страница API"
      });

      if (reachedKnownPage || !hasNextPage(payload, page, items)) break;
      page += 1;
      await sleep(180);
    }

    return fetched;
  }

  function groupCommentsByPost(comments) {
    const map = new Map();
    for (const comment of comments) {
      const key = String(comment.post_id || "unknown");
      if (!map.has(key)) {
        map.set(key, {
          post_id: comment.post_id || null,
          post: comment.post || null,
          comments: []
        });
      }
      const group = map.get(key);
      if (!group.post && comment.post) group.post = comment.post;
      group.comments.push({
        id: comment.id,
        parent_id: comment.parent_id,
        body_text: comment.body_text,
        body_html: comment.body_html,
        created_at: comment.created_at,
        rating: comment.rating,
        url: comment.url
      });
    }
    return Object.fromEntries(map.entries());
  }

  function compareNewestFirst(left, right) {
    const leftTime = new Date(left.created_at || 0).getTime() || 0;
    const rightTime = new Date(right.created_at || 0).getTime() || 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return Number(right.id || 0) - Number(left.id || 0);
  }

  function mergeById(cachedItems = [], fetchedItems = []) {
    const map = new Map();
    for (const item of cachedItems) {
      if (item?.id !== undefined && item?.id !== null) map.set(String(item.id), item);
    }
    for (const item of fetchedItems) {
      if (item?.id !== undefined && item?.id !== null) map.set(String(item.id), item);
    }
    return Array.from(map.values()).sort(compareNewestFirst);
  }

  function inLastHours(item, hours) {
    if (!item.created_at) return false;
    const time = new Date(item.created_at).getTime();
    return Number.isFinite(time) && time >= Date.now() - hours * 60 * 60 * 1000;
  }

  function makeDataset(profile, posts, comments, cacheInfo = null) {
    const recentPosts = posts.filter((post) => inLastHours(post, 72));
    const recentComments = comments.filter((comment) => inLastHours(comment, 72));
    return {
      schema: DATASET_SCHEMA,
      generated_at: new Date().toISOString(),
      cache: cacheInfo,
      source: {
        profile_url: profile.url,
        posts_api: `/api/v1.1/user/${profile.id}/posts?page=N&sort=fresh`,
        comments_api: `/api/v1.1/user/${profile.id}/comments?page=N&sort=fresh`
      },
      user: profile,
      counts: {
        posts: posts.length,
        comments: comments.length,
        recent_72h_posts: recentPosts.length,
        recent_72h_comments: recentComments.length,
        commented_posts: Object.keys(groupCommentsByPost(comments)).length
      },
      posts,
      comments,
      commented_posts: groupCommentsByPost(comments),
      recent_72h: {
        since: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
        posts: recentPosts,
        comments: recentComments,
        commented_posts: groupCommentsByPost(recentComments)
      }
    };
  }

  function compactForGemini(dataset) {
    const maxRecentPosts = 24;
    const maxRecentComments = 48;
    const maxSamplePosts = 10;
    const maxSampleComments = 24;
    const cleanText = (text) => {
      const value = String(text || "")
        .replace(/\[object Object\]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return value;
    };
    const trim = (text, size = 260) => {
      const value = cleanText(text);
      return value.length > size ? `${value.slice(0, size)}...` : value;
    };
    const isUseful = (text) => trim(text, 80).length > 0;
    const channelStats = (items) => {
      const counts = new Map();
      for (const item of items) {
        const channel = item.channel?.title || item.post?.channel?.title || "без подсайта";
        counts.set(channel, (counts.get(channel) || 0) + 1);
      }
      return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([channel, count]) => ({ channel, count }));
    };
    const commentShape = (comment) => ({
      id: comment.id,
      post_id: comment.post_id,
      created_at: comment.created_at,
      rating: comment.rating,
      text: trim(comment.body_text, 260),
      commented_post: comment.post
        ? {
            id: comment.post.id,
            title: comment.post.title,
            text: trim(comment.post.body_text || comment.post.blocks_text, 160),
            channel: comment.post.channel?.title || ""
          }
        : null
    });
    const postShape = (post) => ({
      id: post.id,
      created_at: post.created_at,
      title: post.title,
      rating: post.rating,
      comments_count: post.comments_count,
      channel: post.channel?.title || "",
      text: trim(post.body_text || post.blocks_text, 260)
    });

    const recentPosts = dataset.recent_72h.posts.filter((post) =>
      isUseful(`${post.title} ${post.body_text || post.blocks_text}`)
    );
    const recentComments = dataset.recent_72h.comments.filter((comment) =>
      isUseful(comment.body_text)
    );
    const samplePosts = dataset.posts.filter((post) =>
      isUseful(`${post.title} ${post.body_text || post.blocks_text}`)
    );
    const sampleComments = dataset.comments.filter((comment) => isUseful(comment.body_text));
    const hasRecent = recentPosts.length > 0 || recentComments.length > 0;

    return {
      user: dataset.user,
      generated_at: dataset.generated_at,
      counts: dataset.counts,
      selection_note: hasRecent
        ? "Recent activity is present, so all_time_sample is intentionally small."
        : "No recent_72h activity was detected, so use the all_time_sample as a behavioral sample.",
      stats: {
        post_channels_top: channelStats(dataset.posts),
        comment_channels_top: channelStats(dataset.comments)
      },
      recent_72h: {
        since: dataset.recent_72h.since,
        posts: recentPosts.slice(0, maxRecentPosts).map(postShape),
        comments: recentComments.slice(0, maxRecentComments).map(commentShape)
      },
      all_time_sample: {
        newest_posts: samplePosts.slice(0, hasRecent ? 5 : maxSamplePosts).map(postShape),
        newest_comments: sampleComments
          .slice(0, hasRecent ? 12 : maxSampleComments)
          .map(commentShape)
      }
    };
  }

  function buildPrompt(dataset) {
    return `Проанализируй публичную активность пользователя Gonkong по компактной выборке ниже. Это гипотеза, не диагноз.

Верни Markdown на русском:
1. психологический портрет;
2. паттерны поведения: темы, триггеры, манера спора, юмор, повторяющиеся роли;
3. последние 72 часа, если там есть данные; если данных нет, явно напиши, что свежей активности в выборке нет;
4. дерзкое, но не травящее саммари с заголовком "Какой ты персонаж сегодня: ...";
5. 5 проверяемых тезисов по данным.

Не пересказывай весь JSON и не выдумывай факты вне выборки.

ДАННЫЕ:
${JSON.stringify(compactForGemini(dataset), null, 2)}`;
  }

  function setStatus(text, tone = "") {
    const node = state.panel?.querySelector("[data-aishenka-status]");
    if (!node) return;
    node.textContent = text;
    node.dataset.tone = tone;
  }

  function downloadJson(dataset) {
    const blob = new Blob([JSON.stringify(dataset, null, 2)], {
      type: "application/json;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `gonkong-${dataset.user.id}-${dataset.user.slug || "user"}-aishenka.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sendMessage(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, resolve);
    });
  }

  async function getSettings() {
    return chrome.storage.local.get([STORAGE_KEYS.apiKey, STORAGE_KEYS.model]);
  }

  async function saveSettings(apiKey, model) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.apiKey]: apiKey.trim(),
      [STORAGE_KEYS.model]: model.trim() || DEFAULT_MODEL
    });
  }

  async function loadCachedDataset(profile) {
    const key = cacheKey(profile);
    const cached = await chrome.storage.local.get([key]);
    const dataset = cached[key];
    if (!dataset || dataset.schema !== DATASET_SCHEMA) return null;
    if (!Array.isArray(dataset.posts) || !Array.isArray(dataset.comments)) return null;
    return dataset;
  }

  async function saveCachedDataset(profile, dataset) {
    await chrome.storage.local.set({
      [cacheKey(profile)]: dataset
    });
  }

  async function clearCachedDataset() {
    const profile = parseProfileFromLocation();
    if (!profile) return;
    await chrome.storage.local.remove([cacheKey(profile)]);
    state.collected = null;
    state.lastPrompt = "";
    state.progress = null;
    renderProgress();
    renderDatasetSummary(null);
    setStatus("Кэш этого профиля очищен. Следующий сбор пойдет с нуля.", "ok");
  }

  async function collectAll() {
    if (state.collecting) return;
    const profile = parseProfileFromLocation();
    if (!profile) {
      setStatus("Не могу распознать профиль из URL.", "error");
      return;
    }

    state.collecting = true;
    state.progress = {
      posts: { loaded: 0, total: 0, page: 0 },
      comments: { loaded: 0, total: 0, page: 0 }
    };
    renderProgress();
    toggleBusy(true);
    setStatus("Проверяю кэш профиля...");

    try {
      const cached = await loadCachedDataset(profile);
      const cachedPosts = cached?.posts || [];
      const cachedComments = cached?.comments || [];
      const cacheInfo = {
        used: Boolean(cached),
        previous_generated_at: cached?.generated_at || null,
        cached_posts: cachedPosts.length,
        cached_comments: cachedComments.length,
        new_posts: 0,
        new_comments: 0
      };

      setStatus(
        cached
          ? `В кэше: ${cachedPosts.length} постов, ${cachedComments.length} комментариев. Ищу новые посты...`
          : "Кэша нет. Собираю посты через API с нуля..."
      );
      const fetchedPosts = await collectPaginated("posts", profile, normalizePost, cachedPosts);
      const posts = mergeById(cachedPosts, fetchedPosts);
      const cachedPostIds = new Set(cachedPosts.map((post) => post.id));
      cacheInfo.new_posts = fetchedPosts.filter((post) => !cachedPostIds.has(post.id)).length;

      setStatus("Посты готовы. Теперь ищу новые комментарии...");
      const fetchedComments = await collectPaginated(
        "comments",
        profile,
        normalizeComment,
        cachedComments
      );
      const comments = mergeById(cachedComments, fetchedComments);
      const cachedCommentIds = new Set(cachedComments.map((comment) => comment.id));
      cacheInfo.new_comments = fetchedComments.filter(
        (comment) => !cachedCommentIds.has(comment.id)
      ).length;

      state.collected = makeDataset(profile, posts, comments, cacheInfo);
      state.lastPrompt = buildPrompt(state.collected);
      await saveCachedDataset(profile, state.collected);
      renderDatasetSummary(state.collected);
      setStatus(
        cacheInfo.used
          ? `JSON обновлен из кэша: +${cacheInfo.new_posts} постов, +${cacheInfo.new_comments} комментариев.`
          : "JSON готов и сохранен в кэш. Можно скачать или отправить в Gemini.",
        "ok"
      );
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      state.collecting = false;
      toggleBusy(false);
    }
  }

  function toggleBusy(isBusy) {
    state.panel?.querySelectorAll("[data-aishenka-action]").forEach((button) => {
      button.disabled = isBusy;
    });
  }

  function renderDatasetSummary(dataset) {
    const target = state.panel?.querySelector("[data-aishenka-summary]");
    if (!target) return;
    if (!dataset) {
      target.innerHTML = "";
      return;
    }
    target.innerHTML = `
      <div><b>${dataset.counts.posts}</b> постов</div>
      <div><b>${dataset.counts.comments}</b> комментариев</div>
      <div><b>${dataset.counts.commented_posts}</b> постов с комментариями</div>
      <div><b>${dataset.counts.recent_72h_posts}</b> постов и <b>${dataset.counts.recent_72h_comments}</b> комментариев за 72 часа</div>
      ${
        dataset.cache
          ? `<div><b>${dataset.cache.new_posts}</b> новых постов и <b>${dataset.cache.new_comments}</b> новых комментариев</div>`
          : ""
      }
    `;
  }

  async function analyzeWithGemini() {
    if (!state.collected) {
      await collectAll();
    }
    if (!state.collected) return;

    const settings = await getSettings();
    const apiKey = settings[STORAGE_KEYS.apiKey] || "";
    const model = settings[STORAGE_KEYS.model] || DEFAULT_MODEL;
    if (!apiKey) {
      setStatus("Сначала сохрани Gemini API key.", "error");
      return;
    }

    toggleBusy(true);
    setStatus("Отправляю компактный JSON в Gemini...");

    const response = await sendMessage({
      type: "AISHENKA_GEMINI_ANALYZE",
      payload: {
        apiKey,
        model,
        prompt: state.lastPrompt || buildPrompt(state.collected)
      }
    });

    toggleBusy(false);
    if (!response?.ok) {
      setStatus(response?.error || "Gemini вернул ошибку.", "error");
      return;
    }

    const output = state.panel.querySelector("[data-aishenka-result]");
    output.textContent = response.result.text || JSON.stringify(response.result.raw, null, 2);
    setStatus("Анализ получен.", "ok");
  }

  async function copyJson() {
    if (!state.collected) {
      await collectAll();
    }
    if (!state.collected) return;
    await navigator.clipboard.writeText(JSON.stringify(state.collected, null, 2));
    setStatus("JSON скопирован в буфер.", "ok");
  }

  async function copyPrompt() {
    if (!state.collected) {
      await collectAll();
    }
    if (!state.collected) return;
    await navigator.clipboard.writeText(state.lastPrompt || buildPrompt(state.collected));
    setStatus("Prompt для Gemini скопирован.", "ok");
  }

  async function saveApiKeyFromPanel() {
    const apiKey = state.panel.querySelector("[data-aishenka-api-key]").value;
    const model = state.panel.querySelector("[data-aishenka-model]").value;
    await saveSettings(apiKey, model);
    setStatus("Настройки сохранены локально в расширении.", "ok");
  }

  function makePanel() {
    const panel = document.createElement("section");
    panel.className = `${EXTENSION_CLASS} aishenka-panel`;
    panel.hidden = true;
    panel.innerHTML = `
      <div class="aishenka-panel-head">
        <div>
          <h2>AIшенька</h2>
          <p>API-сбор постов и комментариев профиля, JSON-карта поведения и быстрый анализ через Gemini.</p>
          <div class="aishenka-target" data-aishenka-target></div>
        </div>
        <button type="button" class="aishenka-ghost" data-aishenka-close>Закрыть</button>
      </div>

      <div class="aishenka-grid">
        <label class="aishenka-field">
          <span>Gemini API key</span>
          <input type="password" data-aishenka-api-key autocomplete="off" placeholder="AIza..." />
        </label>
        <label class="aishenka-field">
          <span>Модель</span>
          <input type="text" data-aishenka-model value="${DEFAULT_MODEL}" />
        </label>
        <button type="button" data-aishenka-save-key>Сохранить ключ</button>
      </div>

      <div class="aishenka-actions">
        <button type="button" data-aishenka-action="collect">Собрать JSON</button>
        <button type="button" data-aishenka-action="download">Скачать JSON</button>
        <button type="button" data-aishenka-action="copy-json">Скопировать JSON</button>
        <button type="button" data-aishenka-action="copy-prompt">Скопировать prompt</button>
        <button type="button" data-aishenka-action="clear-cache">Сбросить кэш</button>
        <button type="button" class="aishenka-primary" data-aishenka-action="gemini">Отправить в Gemini</button>
      </div>

      <div class="aishenka-status" data-aishenka-status>Готова к сбору.</div>
      <div class="aishenka-progress" data-aishenka-progress></div>
      <div class="aishenka-summary" data-aishenka-summary></div>
      <pre class="aishenka-result" data-aishenka-result></pre>
    `;

    panel.querySelector("[data-aishenka-close]").addEventListener("click", deactivate);
    panel.querySelector("[data-aishenka-save-key]").addEventListener("click", saveApiKeyFromPanel);
    panel.querySelector('[data-aishenka-action="collect"]').addEventListener("click", collectAll);
    panel.querySelector('[data-aishenka-action="download"]').addEventListener("click", async () => {
      if (!state.collected) await collectAll();
      if (state.collected) downloadJson(state.collected);
    });
    panel.querySelector('[data-aishenka-action="copy-json"]').addEventListener("click", copyJson);
    panel.querySelector('[data-aishenka-action="copy-prompt"]').addEventListener("click", copyPrompt);
    panel
      .querySelector('[data-aishenka-action="clear-cache"]')
      .addEventListener("click", clearCachedDataset);
    panel.querySelector('[data-aishenka-action="gemini"]').addEventListener("click", analyzeWithGemini);

    getSettings().then((settings) => {
      panel.querySelector("[data-aishenka-api-key]").value =
        settings[STORAGE_KEYS.apiKey] || "";
      panel.querySelector("[data-aishenka-model]").value =
        settings[STORAGE_KEYS.model] || DEFAULT_MODEL;
    });

    return panel;
  }

  function matchedProfileLinks() {
    const profile = parseProfileFromLocation();
    if (!profile) return [];
    const base = `/u/${profile.id}`;
    const slug = profile.slug ? `${base}-${profile.slug}` : base;
    return Array.from(document.querySelectorAll("a[href]")).filter((link) => {
      const href = new URL(link.href, location.href).pathname;
      return (
        href === slug ||
        href === `${slug}/comments` ||
        href === `${slug}/drafts` ||
        href === `${slug}/subscribers` ||
        href === `${slug}/subscriptions`
      );
    });
  }

  function findProfileNav() {
    const links = matchedProfileLinks();
    if (!links.length) return null;

    const candidates = [];
    for (const link of links) {
      let node = link.parentElement;
      while (node && node !== document.body) {
        const contained = links.filter((item) => node.contains(item));
        const count = contained.length;
        if (count >= Math.min(3, links.length)) {
          const rect = node.getBoundingClientRect();
          const linkRects = contained
            .map((item) => item.getBoundingClientRect())
            .filter((item) => item.width > 0 && item.height > 0);
          const topSpread =
            linkRects.length > 1
              ? Math.max(...linkRects.map((item) => item.top)) -
                Math.min(...linkRects.map((item) => item.top))
              : 0;
          const text = contained.map((item) => item.textContent.trim()).join(" ");
          const looksLikeProfileTabs =
            /Статьи/.test(text) &&
            /Комментарии/.test(text) &&
            /Подпис/.test(text);
          const isCompactRow =
            rect.width >= 240 &&
            rect.height > 0 &&
            rect.height <= 96 &&
            topSpread <= 42;

          if (looksLikeProfileTabs && isCompactRow) {
            candidates.push({
              node,
              count,
              depth: depthOf(node),
              area: rect.width * rect.height,
              top: rect.top
            });
          }
        }
        node = node.parentElement;
      }
    }

    candidates.sort(
      (a, b) =>
        b.count - a.count ||
        a.area - b.area ||
        b.depth - a.depth ||
        a.top - b.top
    );
    return candidates[0]?.node || null;
  }

  function depthOf(node) {
    let depth = 0;
    let cursor = node;
    while (cursor && cursor !== document.body) {
      depth += 1;
      cursor = cursor.parentElement;
    }
    return depth;
  }

  function activate() {
    state.active = true;
    if (state.tab) state.tab.classList.add("aishenka-tab-active");
    if (state.panel) {
      state.panel.hidden = false;
      state.panel.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    if (location.hash !== "#aishenka") {
      history.replaceState(null, "", `${location.pathname}${location.search}#aishenka`);
    }
  }

  function deactivate() {
    state.active = false;
    if (state.tab) state.tab.classList.remove("aishenka-tab-active");
    if (state.panel) state.panel.hidden = true;
    if (location.hash === "#aishenka") {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
  }

  function resetInjectedUi() {
    state.tab?.remove();
    state.panel?.remove();
    state.tab = null;
    state.panel = null;
    state.collected = null;
    state.lastPrompt = "";
    state.progress = null;
    state.profile = null;
    state.profileKey = "";
  }

  function inject() {
    const profile = parseProfileFromLocation();
    if (!profile) {
      if (state.tab || state.panel) resetInjectedUi();
      return;
    }

    const key = profileKey(profile);
    if (state.tab && state.profileKey === key) return;
    if (state.tab || state.panel) resetInjectedUi();

    const nav = findProfileNav();
    if (!nav) return;

    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `${EXTENSION_CLASS} aishenka-tab`;
    tab.textContent = "AIшенька";
    tab.addEventListener("click", activate);
    nav.appendChild(tab);

    const panel = makePanel();
    nav.insertAdjacentElement("afterend", panel);

    state.tab = tab;
    state.panel = panel;
    state.profile = profile;
    state.profileKey = key;

    const target = panel.querySelector("[data-aishenka-target]");
    if (target) {
      target.textContent = `Цель: user_id ${profile.id}${profile.slug ? `, ${profile.slug}` : ""}`;
    }

    if (location.hash === "#aishenka") {
      activate();
    }
  }

  function start() {
    inject();
    const observer = new MutationObserver(() => inject());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(inject, 1000);
    window.addEventListener("hashchange", () => {
      if (location.hash === "#aishenka") activate();
    });
  }

  start();
})();
