#!/usr/bin/env node
/**
 * auto-publish.mjs — Автономний автопублікатор контенту Лапки
 *
 * Перевіряє Notion на заплановані stories/posts/reels, публікує через IG API,
 * оновлює статус в Notion.
 *
 * Запуск: node tools/auto-publish.mjs [--dry-run]
 *
 * Env vars:
 *   NOTION_TOKEN       — Notion integration token
 *   IG_ACCESS_TOKEN    — Instagram Content Publishing API token
 *   IG_USER_ID         — Instagram User ID (default: 26895666120025482)
 */

// ── Config ─────────────────────────────────────────────────────────

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const IG_TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID || "26895666120025482";
const IG_API = "https://graph.instagram.com/v21.0";
const NOTION_API = "https://api.notion.com/v1";
const DRY_RUN = process.argv.includes("--dry-run");

const DB = {
  stories: "236b1d24-1974-43a0-80d7-9ed069635aee",
  feed: "2852a6a0-2b4e-80fc-87cb-c5ac9455b37b",
};

// Stories: Статус=select, Файли=url, Стікер=select, Дата=date
// Feed:    Статус=status, Файли GitHub=rich_text, Обраний формат=select, Дата публікації=date

// ── Helpers ─────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" });
  console.log(`[${ts}] ${msg}`);
}

function kyivNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" })
  );
}

function kyivToday() {
  const now = kyivNow();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function kyivTimeHHMM() {
  const now = kyivNow();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Notion API ──────────────────────────────────────────────────────

const NOTION_HEADERS = {
  Authorization: `Bearer ${NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

async function notionQuery(dbId, filter) {
  const res = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
    method: "POST",
    headers: NOTION_HEADERS,
    body: JSON.stringify({ filter, page_size: 20 }),
  });
  const data = await res.json();
  if (data.object === "error") throw new Error(`Notion query: ${data.message}`);
  return data.results;
}

async function notionUpdate(pageId, properties) {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    headers: NOTION_HEADERS,
    body: JSON.stringify({ properties }),
  });
  const data = await res.json();
  if (data.object === "error")
    throw new Error(`Notion update: ${data.message}`);
  return data;
}

function extractText(prop) {
  if (!prop) return "";
  if (prop.type === "rich_text")
    return prop.rich_text?.map((t) => t.plain_text).join("") || "";
  if (prop.type === "title")
    return prop.title?.map((t) => t.plain_text).join("") || "";
  return "";
}

function extractSelect(prop) {
  return prop?.select?.name || prop?.status?.name || null;
}

function extractUrl(prop) {
  if (!prop) return null;
  if (prop.type === "url") return prop.url;
  if (prop.type === "rich_text") {
    const text = prop.rich_text?.map((t) => t.plain_text).join("") || "";
    return text.startsWith("http") ? text.trim() : null;
  }
  if (prop.type === "files") {
    const f = prop.files?.[0];
    return f?.external?.url || f?.file?.url || null;
  }
  return null;
}

function extractDate(prop) {
  return prop?.date?.start || null;
}

// ── Instagram API ───────────────────────────────────────────────────

async function igApi(path, method = "GET", params = {}) {
  const url = new URL(`${IG_API}${path}`);

  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", IG_TOKEN);
    const res = await fetch(url.toString());
    return res.json();
  }

  const body = new URLSearchParams({ ...params, access_token: IG_TOKEN });
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return res.json();
}

async function waitContainer(containerId) {
  for (let i = 0; i < 30; i++) {
    const status = await igApi(`/${containerId}`, "GET", {
      fields: "status_code,status",
    });
    if (status.status_code === "FINISHED") return status;
    if (status.status_code === "ERROR")
      throw new Error(`Container error: ${JSON.stringify(status)}`);
    if (status.status_code === "EXPIRED")
      throw new Error("Container expired");

    const waitMs = Math.min(3000 * Math.pow(1.5, Math.min(i, 5)), 30000);
    log(`  ⏳ ${status.status_code} — wait ${(waitMs / 1000).toFixed(0)}s...`);
    await sleep(waitMs);
  }
  throw new Error(`Container ${containerId} did not finish`);
}

async function publishMedia(containerId) {
  const result = await igApi(`/${IG_USER_ID}/media_publish`, "POST", {
    creation_id: containerId,
  });
  if (result.error)
    throw new Error(`Publish error: ${JSON.stringify(result.error)}`);
  return result.id;
}

async function publishStory(fileUrl) {
  const isVideo =
    fileUrl.includes(".mp4") ||
    fileUrl.includes("video") ||
    fileUrl.includes(".mov");
  const params = { media_type: "STORIES" };
  if (isVideo) params.video_url = fileUrl;
  else params.image_url = fileUrl;

  const container = await igApi(`/${IG_USER_ID}/media`, "POST", params);
  if (container.error)
    throw new Error(`Container: ${JSON.stringify(container.error)}`);

  if (isVideo) {
    await waitContainer(container.id);
  } else {
    await sleep(3000);
  }

  return publishMedia(container.id);
}

async function publishPost(fileUrl, caption) {
  const container = await igApi(`/${IG_USER_ID}/media`, "POST", {
    image_url: fileUrl,
    caption: caption,
  });
  if (container.error)
    throw new Error(`Container: ${JSON.stringify(container.error)}`);

  await waitContainer(container.id);
  return publishMedia(container.id);
}

async function publishCarousel(fileUrls, caption) {
  const childIds = [];
  for (const url of fileUrls) {
    const isVideo =
      url.includes(".mp4") || url.includes("video") || url.includes(".mov");
    const params = { is_carousel_item: "true" };
    if (isVideo) {
      params.media_type = "VIDEO";
      params.video_url = url;
    } else {
      params.image_url = url;
    }
    const child = await igApi(`/${IG_USER_ID}/media`, "POST", params);
    if (child.error)
      throw new Error(`Carousel child: ${JSON.stringify(child.error)}`);
    childIds.push(child.id);

    // Wait for video items
    if (isVideo) await waitContainer(child.id);
  }

  const carousel = await igApi(`/${IG_USER_ID}/media`, "POST", {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption: caption,
  });
  if (carousel.error)
    throw new Error(`Carousel: ${JSON.stringify(carousel.error)}`);

  await waitContainer(carousel.id);
  return publishMedia(carousel.id);
}

async function publishReel(videoUrl, caption) {
  const container = await igApi(`/${IG_USER_ID}/media`, "POST", {
    media_type: "REELS",
    video_url: videoUrl,
    caption: caption,
  });
  if (container.error)
    throw new Error(`Container: ${JSON.stringify(container.error)}`);

  await waitContainer(container.id);
  return publishMedia(container.id);
}

async function postComment(mediaId, comment) {
  if (!comment) return;
  const result = await igApi(`/${mediaId}/comments`, "POST", {
    message: comment,
  });
  if (result.error) {
    log(`  ⚠️ Comment failed: ${JSON.stringify(result.error)}`);
    return null;
  }
  return result.id;
}

// ── Main Logic ──────────────────────────────────────────────────────

async function processStories() {
  const today = kyivToday();
  const currentTime = kyivTimeHHMM();

  log(`📱 Stories: querying for date=${today}, time<=${currentTime}`);

  // Stories DB: Статус is "select" type
  const pages = await notionQuery(DB.stories, {
    and: [
      { property: "Статус", select: { equals: "📅 Заплановано" } },
      { property: "Дата", date: { equals: today } },
    ],
  });

  let published = 0;

  for (const page of pages) {
    const props = page.properties;
    const name =
      extractText(props["№"]) || extractText(props["Тема сторіз"]) || page.id;
    const time = extractText(props["Час публікації"]);
    const sticker = extractSelect(props["Стікер"]);
    const fileUrl = extractUrl(props["Файли"]);

    // Filter: time must be set and <= current time
    if (!time) {
      log(`  ⏭️ ${name}: no publish time set, skip`);
      continue;
    }
    if (time > currentTime) {
      log(`  ⏭️ ${name}: scheduled for ${time}, now ${currentTime}, skip`);
      continue;
    }

    // Filter: must have file
    if (!fileUrl) {
      log(`  ⚠️ ${name}: no file URL, skip`);
      continue;
    }

    // Filter: skip interactive stickers (need manual publish)
    if (sticker && sticker !== "➖ Без стікера") {
      log(`  ⏭️ ${name}: has sticker "${sticker}", needs manual publish`);
      continue;
    }

    log(`  📤 ${name}: publishing story...`);

    if (DRY_RUN) {
      log(`  🏷️ DRY RUN: would publish ${fileUrl}`);
      published++;
      continue;
    }

    try {
      const mediaId = await publishStory(fileUrl);
      log(`  ✅ Published! Media ID: ${mediaId}`);

      // Update Notion status
      await notionUpdate(page.id, {
        Статус: { select: { name: "✅ Викладено" } },
      });
      log(`  📝 Notion status → ✅ Викладено`);
      published++;
    } catch (err) {
      log(`  ❌ ${name}: ${err.message}`);
    }

    await sleep(2000); // Rate limit between publishes
  }

  return published;
}

async function processFeed() {
  const today = kyivToday();
  const currentTime = kyivTimeHHMM();

  log(`📰 Feed: querying for date=${today}, time<=${currentTime}`);

  // Feed DB: Статус is "status" type
  const pages = await notionQuery(DB.feed, {
    and: [
      { property: "Статус", status: { equals: "📅 Заплановано" } },
      { property: "Дата публікації", date: { equals: today } },
    ],
  });

  let published = 0;

  for (const page of pages) {
    const props = page.properties;
    const name = extractText(props["Назва / тема посту"]) || page.id;
    const time = extractText(props["Час публікації"]);
    const format = extractSelect(props["Обраний формат"]);
    const caption = extractText(props["Концепт / сценарій"]);
    const filesRaw = extractText(props["Файли GitHub"]);

    // Filter: time must be set and <= current time
    if (!time) {
      log(`  ⏭️ ${name}: no publish time set, skip`);
      continue;
    }
    if (time > currentTime) {
      log(`  ⏭️ ${name}: scheduled for ${time}, now ${currentTime}, skip`);
      continue;
    }

    // Parse file URLs (may be comma-separated or newline-separated)
    const fileUrls = filesRaw
      ? filesRaw
          .split(/[,\n]/)
          .map((u) => u.trim())
          .filter((u) => u.startsWith("http"))
      : [];

    if (fileUrls.length === 0) {
      log(`  ⚠️ ${name}: no file URLs in "Файли GitHub", skip`);
      continue;
    }

    log(`  📤 ${name}: publishing as ${format || "auto"}...`);

    if (DRY_RUN) {
      log(`  🏷️ DRY RUN: would publish ${fileUrls.length} file(s)`);
      published++;
      continue;
    }

    try {
      let mediaId;

      // Determine publish type based on format and file count
      const isReel =
        format === "Reel" ||
        format === "Reels" ||
        fileUrls[0].includes(".mp4") ||
        fileUrls[0].includes(".mov");
      const isCarousel =
        (format === "Карусель" || fileUrls.length > 1) && !isReel;

      // Extract hashtags from caption — publish them as first comment
      let cleanCaption = caption;
      let hashtags = null;
      const hashMatch = caption.match(/((?:#[^\s#]+[\s]*){3,})$/);
      if (hashMatch) {
        hashtags = hashMatch[1].trim();
        cleanCaption = caption.slice(0, hashMatch.index).trim();
      }

      if (isReel) {
        mediaId = await publishReel(fileUrls[0], cleanCaption);
      } else if (isCarousel) {
        mediaId = await publishCarousel(fileUrls, cleanCaption);
      } else {
        mediaId = await publishPost(fileUrls[0], cleanCaption);
      }

      log(`  ✅ Published! Media ID: ${mediaId}`);

      // Post hashtags as first comment
      if (hashtags) {
        await postComment(mediaId, hashtags);
        log(`  💬 Hashtags comment posted`);
      }

      // Update Notion status
      await notionUpdate(page.id, {
        Статус: { status: { name: "🚀 Опубліковано" } },
      });
      log(`  📝 Notion status → 🚀 Опубліковано`);
      published++;
    } catch (err) {
      log(`  ❌ ${name}: ${err.message}`);
    }

    await sleep(2000);
  }

  return published;
}

// ── Entry point ─────────────────────────────────────────────────────

async function main() {
  if (!NOTION_TOKEN) {
    console.error("❌ NOTION_TOKEN not set");
    process.exit(1);
  }
  if (!IG_TOKEN) {
    console.error("❌ IG_ACCESS_TOKEN not set");
    process.exit(1);
  }

  log("🚀 Lapka Auto-Publisher starting...");
  log(`   Kyiv time: ${kyivTimeHHMM()}, date: ${kyivToday()}`);
  if (DRY_RUN) log("   🏷️ DRY RUN MODE — no actual publishing");

  let totalPublished = 0;

  try {
    const stories = await processStories();
    totalPublished += stories;
  } catch (err) {
    log(`❌ Stories error: ${err.message}`);
  }

  try {
    const feed = await processFeed();
    totalPublished += feed;
  } catch (err) {
    log(`❌ Feed error: ${err.message}`);
  }

  log(
    `✅ Done. Published ${totalPublished} item(s).${totalPublished === 0 ? " Nothing scheduled for now." : ""}`
  );
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
