// Background script — handles Reddit API calls, caching, icon state, avatars

const cache = new Map(); // videoId -> { posts, timestamp }
const avatarCache = new Map(); // username -> { url, timestamp }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const AVATAR_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
let lastRequestTime = 0;
let redditJsonApiBlocked = false;
const MIN_REQUEST_INTERVAL = 1000; // 1s between requests

// --- Reddit API ---

async function rateLimitedFetch(url, accept = '*/*') {
  const now = Date.now();
  const wait = Math.max(0, MIN_REQUEST_INTERVAL - (now - lastRequestTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();

  const resp = await fetch(url, {
    credentials: 'include',
    headers: { Accept: accept },
  });

  if (resp.status === 429) {
    await new Promise(r => setTimeout(r, 3000));
    lastRequestTime = Date.now();
    return fetch(url, {
      credentials: 'include',
      headers: { Accept: accept },
    });
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
      url: titleLink.href,
      thumbnail: thumbnail || 'self',
      selftext: '',
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

async function searchRedditJson(videoId) {
  const queries = [
    `url:youtube.com/watch?v=${videoId}`,
    `url:youtu.be/${videoId}`,
  ];
  const allPosts = [];

  for (const query of queries) {
    const result = await fetchRedditJson(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=top&type=link&limit=25&sr_detail=1&raw_json=1`
    );
    for (const child of result?.data?.children || []) {
      if (child.kind === 't3') allPosts.push(child.data);
    }
  }

  return allPosts;
}

async function searchRedditHtml(videoId) {
  const resp = await rateLimitedFetch(
    `https://old.reddit.com/search?q=${encodeURIComponent(videoId)}&sort=top&type=link&t=all`,
    'text/html'
  );
  if (!resp.ok) throw new Error(`Reddit page search returned HTTP ${resp.status}`);
  return parseOldRedditSearch(await resp.text());
}

async function searchReddit(videoId) {
  const cached = cache.get(videoId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { ok: true, posts: cached.posts, fromCache: true };
  }

  try {
    let allPosts = [];
    if (!redditJsonApiBlocked) {
      try {
        allPosts = await searchRedditJson(videoId);
      } catch (e) {
        // Public JSON endpoints may reject browser extensions; use the public page.
      }
    }
    if (!allPosts.length) allPosts = await searchRedditHtml(videoId);

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

    const pageSort = sort === 'best' ? 'confidence' : sort;
    const pageUrl = new URL(permalink, 'https://old.reddit.com');
    pageUrl.hostname = 'old.reddit.com';
    pageUrl.searchParams.set('sort', pageSort);
    const resp = await rateLimitedFetch(pageUrl.href, 'text/html');
    if (!resp.ok) throw new Error(`Reddit comments page returned HTTP ${resp.status}`);
    return { ok: true, post: null, comments: parseOldRedditComments(await resp.text()) };
  } catch (err) {
    return { ok: false, error: err.message, comments: [] };
  }
}

// --- Load more comments ---

async function fetchMoreChildren(linkId, childrenIds, sort = 'top') {
  try {
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
    fetchMoreChildren(msg.linkId, msg.children, msg.sort).then(result => {
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
