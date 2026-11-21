// Background script — handles Reddit API calls, caching, icon state, avatars

const cache = new Map(); // videoId -> { posts, timestamp }
const avatarCache = new Map(); // username -> { url, timestamp }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const AVATAR_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
let lastRequestTime = 0;
let redditJsonApiBlocked = false;
const MIN_REQUEST_INTERVAL = 1000; // 1s between requests

// --- Reddit API ---

async function rateLimitedFetch(url, accept = '*/*', init = {}) {
  const now = Date.now();
  const wait = Math.max(0, MIN_REQUEST_INTERVAL - (now - lastRequestTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();

  // no-store: Reddit marks its redirect to the login page as cacheable for an
  // hour, so a search made while signed out would keep failing after signing in.
  const options = {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: accept, ...init.headers },
  };
  const resp = await fetch(url, options);

  if (resp.status === 429) {
    await new Promise(r => setTimeout(r, 3000));
    lastRequestTime = Date.now();
    return fetch(url, options);
  }

  return resp;
}

async function fetchRedditJson(url) {
  const resp = await rateLimitedFetch(url, 'application/json');
  const contentType = resp.headers.get('content-type') || '';

  if (!resp.ok || !contentType.includes('json')) {
    if (resp.status === 401 || resp.status === 403 || !contentType.includes('json')) {
      redditJsonApiBlocked = true;
    }
    throw new Error(`Reddit JSON API returned HTTP ${resp.status}`);
  }

  return resp.json();
}

function parseNumber(text) {
  const match = String(text || '')
    .replace(/,/g, '')
    .match(/-?[\d.]+\s*[km]?/i);
  if (!match) return 0;

  const value = Number.parseFloat(match[0]);
  const suffix = match[0].trim().slice(-1).toLowerCase();
  if (suffix === 'k') return Math.round(value * 1000);
  if (suffix === 'm') return Math.round(value * 1000000);
  return Math.round(value);
}

function toRedditPath(url) {
  try {
    return new URL(url, 'https://www.reddit.com').pathname;
  } catch (e) {
    return '';
  }
}

function normalizeImageUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  try {
    return new URL(url, 'https://old.reddit.com').href;
  } catch (e) {
    return '';
  }
}

// --- Video matching ---
// Reddit search is fuzzy: it tokenizes the query, ignores case, and falls back to
// loosely related posts. Every result is therefore checked against the video ID
// before it is shown.

const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;

// Video IDs a single URL points at (normally zero or one).
function youtubeIdsInUrl(rawUrl, base) {
  let u;
  try {
    u = new URL(String(rawUrl).replace(/&amp;/g, '&'), base);
  } catch (e) {
    return [];
  }
  if (!YOUTUBE_HOST.test(u.hostname)) return [];

  const ids = [];
  if (/(^|\.)youtu\.be$/i.test(u.hostname)) {
    ids.push(u.pathname.split('/')[1]);
  } else {
    ids.push(u.searchParams.get('v'));
    const pathMatch = u.pathname.match(/^\/(?:shorts|live|embed|v|e)\/([^/?#]+)/);
    if (pathMatch) ids.push(pathMatch[1]);
    // Old share links: /attribution_link?u=%2Fwatch%3Fv%3DID
    const inner = u.searchParams.get('u');
    if (inner && !base) ids.push(...youtubeIdsInUrl(inner, 'https://www.youtube.com'));
  }
  // Keep only the ID itself; pasted links sometimes carry trailing junk.
  return ids.map(id => String(id || '').match(/^[A-Za-z0-9_-]+/)?.[0]).filter(Boolean);
}

function urlsInText(text) {
  const urls = String(text || '')
    .replace(/\\/g, '') // markdown escapes, e.g. v=abc\_def
    .match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return urls.map(url => url.replace(/[.,;:!?*]+$/, ''));
}

// True only when the post links to this exact video (IDs are case-sensitive).
function postReferencesVideo(post, videoId) {
  const parent = post.crosspost_parent_list?.[0] || {};
  const urls = [
    post.url,
    post.url_overridden_by_dest,
    parent.url,
    ...(post.link_urls || []),
    ...urlsInText(post.selftext),
    ...urlsInText(parent.selftext),
  ];
  return urls.some(url => url && youtubeIdsInUrl(url).includes(videoId));
}

function parseOldRedditSearch(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const posts = [];

  for (const result of doc.querySelectorAll('.search-result[data-fullname^="t3_"]')) {
    const titleLink = result.querySelector('a.search-title');
    const commentsLink = result.querySelector('a.search-comments');
    const subredditLink = result.querySelector('a.search-subreddit-link');
    const time = result.querySelector('time');
    const permalink = toRedditPath(commentsLink?.href || titleLink?.href);
    const id = result.dataset.fullname?.replace(/^t3_/, '') || '';

    if (!id || !titleLink || !permalink) continue;

    const thumbnail = normalizeImageUrl(result.querySelector('a.thumbnail img')?.getAttribute('src'));
    // The title links to the thread; the submitted link lives in the footer,
    // and self posts keep their links in the collapsed body.
    const submittedUrl = result.querySelector('.search-result-footer a.search-link')?.getAttribute('href');
    const selftextNode = result.querySelector('.search-expando .md');
    posts.push({
      id,
      name: `t3_${id}`,
      title: titleLink.textContent.trim(),
      subreddit: subredditLink?.textContent.trim().replace(/^r\//i, '') || 'reddit',
      author: result.querySelector('a.author')?.textContent.trim() || '[deleted]',
      score: parseNumber(result.querySelector('.search-score')?.textContent),
      num_comments: parseNumber(commentsLink?.textContent),
      created_utc: time?.dateTime ? Date.parse(time.dateTime) / 1000 : 0,
      permalink,
      url: submittedUrl || titleLink.href,
      // Every link in the result, so matching does not hinge on one class name.
      link_urls: [...result.querySelectorAll('a[href]')].map(a => a.getAttribute('href')),
      thumbnail: thumbnail || 'self',
      selftext: selftextNode?.textContent.trim() || '',
      selftext_html: '',
    });
  }

  return posts;
}

function parseOldRedditComments(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const elements = [...doc.querySelectorAll('.thing.comment[data-fullname^="t1_"]')];
  const nodes = new Map();
  const roots = [];

  for (const element of elements) {
    const entry = [...element.children].find(child => child.classList.contains('entry'));
    if (!entry) continue;

    const fullname = element.dataset.fullname;
    const bodyNode = entry.querySelector('.usertext-body .md');
    const time = entry.querySelector('time');
    const scoreNode = entry.querySelector('.score.unvoted, .score.likes, .score.dislikes');
    const flair = entry.querySelector('.flair');
    const isDeleted = element.classList.contains('deleted') || !bodyNode;
    const author = element.dataset.author || entry.querySelector('a.author')?.textContent.trim();

    nodes.set(fullname, {
      element,
      item: {
        kind: 't1',
        data: {
          id: fullname.replace(/^t1_/, ''),
          name: fullname,
          author: author || '[deleted]',
          body: isDeleted ? '[deleted]' : bodyNode.textContent.trim(),
          body_html: isDeleted ? '' : bodyNode.outerHTML,
          score: parseNumber(scoreNode?.getAttribute('title') || scoreNode?.textContent),
          created_utc: time?.dateTime ? Date.parse(time.dateTime) / 1000 : 0,
          permalink: element.dataset.permalink || '',
          author_flair_text: flair?.textContent.trim() || '',
          author_flair_background_color: '',
          author_flair_text_color: 'dark',
          all_awardings: [],
          gilded: parseNumber(element.dataset.gildings),
          replies: '',
        },
      },
    });
  }

  for (const node of nodes.values()) {
    const parentElement = node.element.parentElement
      ?.closest('.thing.comment[data-fullname^="t1_"]');
    const parent = parentElement ? nodes.get(parentElement.dataset.fullname) : null;

    if (!parent) {
      roots.push(node.item);
      continue;
    }

    if (!parent.item.data.replies) {
      parent.item.data.replies = {
        kind: 'Listing',
        data: { children: [] },
      };
    }
    parent.item.data.replies.data.children.push(node.item);
  }

  return roots;
}

// --- Public (signed-out) Reddit pages ---
// Old Reddit and the JSON API both need an account now. New Reddit still serves
// search results and comments to signed-out visitors as server-rendered HTML,
// partly inside <template> elements that querySelectorAll does not descend into.

function queryAllDeep(root, selector) {
  const found = [...root.querySelectorAll(selector)];
  for (const template of root.querySelectorAll('template')) {
    found.push(...queryAllDeep(template.content, selector));
  }
  return found;
}

function parsePublicSearch(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const posts = [];

  for (const unit of queryAllDeep(doc, '[data-testid="search-post-unit"]')) {
    const titleLink = unit.querySelector('a[data-testid="post-title"], a[data-testid="post-title-text"]');
    const permalink = titleLink ? toRedditPath(titleLink.getAttribute('href')) : '';

    let context = {};
    try {
      context = JSON.parse(
        unit.querySelector('[data-faceplate-tracking-context]')
          ?.getAttribute('data-faceplate-tracking-context') || '{}'
      );
    } catch (e) {
      // Fall back to what the markup itself gives us.
    }

    const id = (context.post?.id || '').replace(/^t3_/, '') ||
      permalink.match(/\/comments\/([a-z0-9]+)/i)?.[1] || '';
    if (!id || !permalink) continue;

    const counters = [...unit.querySelectorAll('[data-testid="search-counter-row"] faceplate-number')]
      .map(node => parseNumber(node.getAttribute('number')));
    const timestamp = unit.querySelector('faceplate-timeago')?.getAttribute('ts');
    const thumbnail = normalizeImageUrl(
      unit.querySelector('[data-testid="search_post_thumbnail"] faceplate-img, [data-testid="search_post_thumbnail"] img')
        ?.getAttribute('src')
    );
    const communityIcon = normalizeImageUrl(
      unit.querySelector('[data-testid="sdui-post-unit"] img[src*="communityIcon"], [data-testid="sdui-post-unit"] img[src*="/styles/"]')
        ?.getAttribute('src')
    );

    posts.push({
      id,
      name: `t3_${id}`,
      title: context.post?.title || titleLink.getAttribute('aria-label') || titleLink.textContent.trim(),
      subreddit: context.subreddit?.name || permalink.split('/')[2] || 'reddit',
      author: context.profile?.name || '[deleted]',
      score: counters[0] || 0,
      num_comments: counters[1] || 0,
      created_utc: timestamp ? Date.parse(timestamp) / 1000 : 0,
      permalink,
      // This page does not expose the submitted link, so these results cannot
      // be checked against the video ID; they rest on the `url:` query alone.
      url: `https://www.reddit.com${permalink}`,
      thumbnail: thumbnail || 'self',
      sr_detail: communityIcon ? { community_icon: communityIcon } : undefined,
      selftext: '',
      selftext_html: '',
    });
  }

  return posts;
}

function parsePublicComments(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = new Map();
  const roots = [];

  for (const element of queryAllDeep(doc, 'shreddit-comment')) {
    const fullname = element.getAttribute('thingid');
    if (!fullname || nodes.has(fullname)) continue;

    const bodyNode = [...element.querySelectorAll('[slot="comment"]')]
      .find(node => node.closest('shreddit-comment') === element);
    const created = element.getAttribute('created');

    nodes.set(fullname, {
      parentId: element.getAttribute('parentid'),
      item: {
        kind: 't1',
        data: {
          id: fullname.replace(/^t1_/, ''),
          name: fullname,
          author: element.getAttribute('author') || '[deleted]',
          body: bodyNode ? bodyNode.textContent.trim() : '[deleted]',
          body_html: bodyNode ? bodyNode.innerHTML : '',
          score: parseNumber(element.getAttribute('score')),
          created_utc: created ? Date.parse(created) / 1000 : 0,
          permalink: element.getAttribute('permalink') || '',
          author_flair_text: '',
          author_flair_background_color: '',
          author_flair_text_color: 'dark',
          all_awardings: [],
          gilded: 0,
          replies: '',
        },
      },
    });
  }

  const attach = (parentId, item) => {
    const parent = parentId ? nodes.get(parentId) : null;
    if (!parent) {
      roots.push(item);
      return;
    }
    if (!parent.item.data.replies) {
      parent.item.data.replies = { kind: 'Listing', data: { children: [] } };
    }
    parent.item.data.replies.data.children.push(item);
  };

  for (const node of nodes.values()) attach(node.parentId, node.item);

  // "More replies" / "view more comments" continuations.
  for (const partial of queryAllDeep(doc, 'faceplate-partial[src*="/more-comments/"]')) {
    const src = partial.getAttribute('src');
    const cursor = partial.querySelector('input[name="cursor"]')?.value;
    if (!src || !cursor) continue;

    const remaining = new URL(src, 'https://www.reddit.com').searchParams.get('comments-remaining');
    attach(partial.closest('shreddit-comment')?.getAttribute('thingid'), {
      kind: 'more',
      data: { count: parseNumber(remaining), children: [cursor], src, cursor },
    });
  }

  return roots;
}

async function searchRedditPublic(videoId) {
  const query = `url:${videoId}`;
  const resp = await rateLimitedFetch(
    `https://www.reddit.com/search/?q=${encodeURIComponent(query)}&type=posts&sort=top`,
    'text/html'
  );
  if (!resp.ok) throw new Error(`Reddit search page returned HTTP ${resp.status}`);
  return parsePublicSearch(await resp.text());
}

async function fetchCommentsPublic(permalink, sort) {
  const pageUrl = new URL(permalink.replace(/\/?$/, '/'), 'https://www.reddit.com');
  pageUrl.hostname = 'www.reddit.com';
  pageUrl.searchParams.set('sort', sort === 'best' ? 'confidence' : sort);
  const resp = await rateLimitedFetch(pageUrl.href, 'text/html');
  if (!resp.ok) throw new Error(`Reddit thread page returned HTTP ${resp.status}`);
  return parsePublicComments(await resp.text());
}

async function fetchMorePublic(more) {
  const url = new URL(more.src, 'https://www.reddit.com');
  if (url.origin !== 'https://www.reddit.com' ||
      !url.pathname.startsWith('/svc/shreddit/more-comments/')) {
    throw new Error('Unexpected comment continuation');
  }
  const resp = await rateLimitedFetch(url.href, 'text/html', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ cursor: more.cursor }).toString(),
  });
  if (!resp.ok) throw new Error(`Reddit returned HTTP ${resp.status}`);
  return parsePublicComments(await resp.text());
}

// --- Old Reddit pages (signed-in) ---

let oldRedditLoginUntil = 0; // skip old Reddit while it is known to demand a login
const LOGIN_RECHECK_INTERVAL = 5 * 60 * 1000;

async function fetchOldRedditPage(url) {
  if (Date.now() < oldRedditLoginUntil) throw new Error('Reddit login required');

  const resp = await rateLimitedFetch(url, 'text/html');
  if (!resp.ok) throw new Error(`Reddit page returned HTTP ${resp.status}`);
  // Old Reddit sends signed-out visitors to its login page with a 200.
  if (resp.url && new URL(resp.url).pathname.startsWith('/login')) {
    oldRedditLoginUntil = Date.now() + LOGIN_RECHECK_INTERVAL;
    throw new Error('Reddit login required');
  }
  return resp.text();
}

async function searchRedditJson(videoId) {
  // `url:ID` matches the ID inside any YouTube URL shape. Longer forms such as
  // `url:youtube.com/watch?v=ID` get tokenized and match unrelated YouTube links.
  const query = `url:${videoId}`;
  const result = await fetchRedditJson(
    `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=top&type=link&limit=100&sr_detail=1&raw_json=1`
  );
  return (result?.data?.children || [])
    .filter(child => child.kind === 't3')
    .map(child => child.data)
    .filter(post => postReferencesVideo(post, videoId));
}

async function searchRedditHtml(videoId) {
  // Never search for the bare ID: that is a full-text search, and it returns
  // megathreads and posts that only share a fragment of the ID.
  const query = `url:${videoId}`;
  const html = await fetchOldRedditPage(
    `https://old.reddit.com/search?q=${encodeURIComponent(query)}&sort=top&type=link&t=all&limit=100`
  );
  return parseOldRedditSearch(html).filter(post => postReferencesVideo(post, videoId));
}

async function fetchCommentsOldReddit(permalink, sort) {
  const pageUrl = new URL(permalink, 'https://old.reddit.com');
  pageUrl.hostname = 'old.reddit.com';
  pageUrl.searchParams.set('sort', sort === 'best' ? 'confidence' : sort);
  return parseOldRedditComments(await fetchOldRedditPage(pageUrl.href));
}

async function searchReddit(videoId) {
  const cached = cache.get(videoId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { ok: true, posts: cached.posts, fromCache: true };
  }

  try {
    let allPosts = null;
    if (!redditJsonApiBlocked) {
      try {
        allPosts = await searchRedditJson(videoId);
      } catch (e) {
        // Public JSON endpoints may reject browser extensions; use the public page.
      }
    }
    // Only when the JSON API is unavailable — an empty answer from it is final.
    if (allPosts === null) {
      try {
        allPosts = await searchRedditHtml(videoId);
      } catch (oldRedditError) {
        // Signed out (or old Reddit is down): use the public search page.
        try {
          allPosts = await searchRedditPublic(videoId);
        } catch (e) {
          throw oldRedditError;
        }
      }
    }

    const seen = new Set();
    const posts = allPosts
      .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
      .sort((a, b) => b.num_comments - a.num_comments);

    // Only cache if we got results — don't cache empty/failed responses
    if (posts.length > 0) {
      cache.set(videoId, { posts, timestamp: Date.now() });
    }
    return { ok: true, posts };
  } catch (err) {
    // On error, return cached results if we have any (even if expired)
    const stale = cache.get(videoId);
    if (stale?.posts?.length) {
      return { ok: true, posts: stale.posts, fromCache: true };
    }
    return { ok: false, error: err.message, posts: [] };
  }
}

async function fetchComments(permalink, sort = 'top') {
  try {
    if (!redditJsonApiBlocked) {
      try {
        const data = await fetchRedditJson(
          `https://www.reddit.com${permalink}.json?sort=${encodeURIComponent(sort)}&limit=100`
        );
        if (Array.isArray(data) && data.length >= 2) {
          const post = data[0]?.data?.children?.[0]?.data || null;
          const comments = (data[1]?.data?.children || [])
            .map(c => ({ kind: c.kind, data: c.data }));
          return { ok: true, post, comments };
        }
      } catch (e) {
        // Continue with the old Reddit HTML parser below.
      }
    }

    let comments;
    try {
      comments = await fetchCommentsOldReddit(permalink, sort);
    } catch (oldRedditError) {
      // Signed out (or old Reddit is down): read the public thread page.
      try {
        comments = await fetchCommentsPublic(permalink, sort);
      } catch (e) {
        throw oldRedditError;
      }
    }
    return { ok: true, post: null, comments };
  } catch (err) {
    return { ok: false, error: err.message, comments: [] };
  }
}

// --- Load more comments ---

async function fetchMoreChildren(linkId, childrenIds, sort = 'top', more = null) {
  try {
    // Continuations that came from a public thread page carry their own cursor.
    if (more?.cursor) return { ok: true, comments: await fetchMorePublic(more) };

    const ids = childrenIds.slice(0, 100).join(',');
    const data = await fetchRedditJson(
      `https://www.reddit.com/api/morechildren.json?api_type=json&link_id=t3_${linkId}&children=${ids}&sort=${encodeURIComponent(sort)}`
    );
    const things = data?.json?.data?.things || [];
    return { ok: true, comments: things };
  } catch (err) {
    return { ok: false, error: err.message, comments: [] };
  }
}

// --- Avatar fetching ---

async function fetchAvatar(username) {
  if (!username || username === '[deleted]' || username === '[removed]') {
    return { ok: true, url: null };
  }
  if (redditJsonApiBlocked) return { ok: true, url: null };

  const cached = avatarCache.get(username);
  if (cached && Date.now() - cached.timestamp < AVATAR_CACHE_TTL) {
    return { ok: true, url: cached.url };
  }

  try {
    const data = await fetchRedditJson(
      `https://www.reddit.com/user/${encodeURIComponent(username)}/about.json`
    );
    const url = data?.data?.snoovatar_img || data?.data?.icon_img || null;
    // Clean up Reddit's image URL (remove query params that cause issues)
    const cleanUrl = url ? url.split('?')[0] : null;
    avatarCache.set(username, { url: cleanUrl, timestamp: Date.now() });
    return { ok: true, url: cleanUrl };
  } catch (err) {
    return { ok: true, url: null };
  }
}

async function fetchAvatarsBatch(usernames) {
  const results = {};
  const toFetch = [];

  for (const u of usernames) {
    if (!u || u === '[deleted]' || u === '[removed]') continue;
    const cached = avatarCache.get(u);
    if (cached && Date.now() - cached.timestamp < AVATAR_CACHE_TTL) {
      results[u] = cached.url;
    } else {
      toFetch.push(u);
    }
  }

  // Fetch up to 10 at a time to avoid rate limits
  const batch = toFetch.slice(0, 10);
  const fetched = await Promise.allSettled(
    batch.map(async u => {
      const r = await fetchAvatar(u);
      results[u] = r.url;
    })
  );

  return { ok: true, avatars: results, remaining: toFetch.slice(10) };
}

// --- Sort preference ---

async function getSortPref() {
  return new Promise(resolve => {
    chrome.storage.local.get(['sortPref'], data => {
      resolve(data.sortPref || 'top');
    });
  });
}

async function setSortPref(sort) {
  return new Promise(resolve => {
    chrome.storage.local.set({ sortPref: sort }, resolve);
  });
}

// --- Icon management ---

function updateIcon(tabId, postCount) {
  const iconPaths = {
    16: `icons/icon-16${postCount > 0 ? '-active' : ''}.png`,
    48: `icons/icon-48${postCount > 0 ? '-active' : ''}.png`,
  };

  chrome.browserAction.setIcon({ tabId, path: iconPaths });
  chrome.browserAction.setBadgeText({ tabId, text: postCount > 0 ? String(postCount) : '' });
  if (postCount > 0) {
    chrome.browserAction.setBadgeBackgroundColor({ tabId, color: '#FF4500' });
  }
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SEARCH_VIDEO') {
    searchReddit(msg.videoId).then(result => {
      const tabId = sender.tab?.id || msg.tabId;
      if (tabId) updateIcon(tabId, result.posts.length);
      sendResponse(result);
    });
    return true;
  }

  if (msg.type === 'FETCH_COMMENTS') {
    fetchComments(msg.permalink, msg.sort).then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (msg.type === 'FETCH_MORE_CHILDREN') {
    fetchMoreChildren(msg.linkId, msg.children, msg.sort, msg.more).then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (msg.type === 'FETCH_AVATARS') {
    fetchAvatarsBatch(msg.usernames).then(result => {
      sendResponse(result);
    });
    return true;
  }

  if (msg.type === 'GET_SORT_PREF') {
    getSortPref().then(sort => sendResponse({ sort }));
    return true;
  }

  if (msg.type === 'SET_SORT_PREF') {
    setSortPref(msg.sort).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'GET_VIDEO_ID') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]?.url) {
        const url = new URL(tabs[0].url);
        const videoId = url.searchParams.get('v');
        sendResponse({ videoId, tabId: tabs[0].id });
      } else {
        sendResponse({ videoId: null });
      }
    });
    return true;
  }
});

console.log('Reddit Comments for YouTube: background loaded');
