// Background script — handles Reddit API calls, caching, icon state, avatars

const cache = new Map(); // videoId -> { posts, timestamp }
const avatarCache = new Map(); // username -> { url, timestamp }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const AVATAR_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000; // 1s between requests

// --- Reddit API ---

async function rateLimitedFetch(url) {
  const now = Date.now();
  const wait = Math.max(0, MIN_REQUEST_INTERVAL - (now - lastRequestTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'RedditCommentsForYouTube/1.0' }
  });

  if (resp.status === 429) {
    await new Promise(r => setTimeout(r, 3000));
    lastRequestTime = Date.now();
    return fetch(url, {
      headers: { 'User-Agent': 'RedditCommentsForYouTube/1.0' }
    });
  }

  return resp;
}

async function searchReddit(videoId) {
  const cached = cache.get(videoId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { ok: true, posts: cached.posts, fromCache: true };
  }

  try {
    const queries = [
      `url:youtube.com/watch?v=${videoId}`,
      `url:youtu.be/${videoId}`,
    ];

    const results = await Promise.all(
      queries.map(q =>
        rateLimitedFetch(
          `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=top&type=link&limit=25`
        ).then(r => r.json())
      )
    );

    const allPosts = [];
    for (const result of results) {
      if (result?.data?.children) {
        for (const child of result.data.children) {
          if (child.kind === 't3') allPosts.push(child.data);
        }
      }
    }

    const seen = new Set();
    const posts = allPosts
      .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
      .sort((a, b) => b.num_comments - a.num_comments);

    cache.set(videoId, { posts, timestamp: Date.now() });
    return { ok: true, posts };
  } catch (err) {
    return { ok: false, error: err.message, posts: [] };
  }
}

async function fetchComments(permalink, sort = 'top') {
  try {
    const resp = await rateLimitedFetch(
      `https://www.reddit.com${permalink}.json?sort=${encodeURIComponent(sort)}&limit=100`
    );
    const data = await resp.json();

    if (!Array.isArray(data) || data.length < 2) {
      return { ok: false, error: 'Unexpected response format', comments: [] };
    }

    const post = data[0]?.data?.children?.[0]?.data || null;
    const comments = (data[1]?.data?.children || []).map(c => ({ kind: c.kind, data: c.data }));

    return { ok: true, post, comments };
  } catch (err) {
    return { ok: false, error: err.message, comments: [] };
  }
}

// --- Load more comments ---

async function fetchMoreChildren(linkId, childrenIds, sort = 'top') {
  try {
    const ids = childrenIds.slice(0, 100).join(',');
    const resp = await rateLimitedFetch(
      `https://www.reddit.com/api/morechildren.json?api_type=json&link_id=t3_${linkId}&children=${ids}&sort=${encodeURIComponent(sort)}`
    );
    const data = await resp.json();
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

  const cached = avatarCache.get(username);
  if (cached && Date.now() - cached.timestamp < AVATAR_CACHE_TTL) {
    return { ok: true, url: cached.url };
  }

  try {
    const resp = await rateLimitedFetch(
      `https://www.reddit.com/user/${encodeURIComponent(username)}/about.json`
    );
    const data = await resp.json();
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

  const setIcon = chrome.browserAction
    ? chrome.browserAction.setIcon.bind(chrome.browserAction)
    : chrome.action.setIcon.bind(chrome.action);

  const setBadge = chrome.browserAction
    ? chrome.browserAction.setBadgeText.bind(chrome.browserAction)
    : chrome.action.setBadgeText.bind(chrome.action);

  const setBadgeBg = chrome.browserAction
    ? chrome.browserAction.setBadgeBackgroundColor.bind(chrome.browserAction)
    : chrome.action.setBadgeBackgroundColor.bind(chrome.action);

  setIcon({ tabId, path: iconPaths });
  setBadge({ tabId, text: postCount > 0 ? String(postCount) : '' });
  if (postCount > 0) {
    setBadgeBg({ tabId, color: '#FF4500' });
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
