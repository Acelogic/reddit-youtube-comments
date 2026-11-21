// Shared utilities for Reddit Comments for YouTube

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) {
      // Standard: /watch?v=ID
      const v = u.searchParams.get('v');
      if (v) return v;
      // Live/premiere: /live/ID
      const liveMatch = u.pathname.match(/^\/live\/([a-zA-Z0-9_-]+)/);
      if (liveMatch) return liveMatch[1];
      // Shorts: /shorts/ID
      const shortsMatch = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
      if (shortsMatch) return shortsMatch[1];
      // Embed: /embed/ID
      const embedMatch = u.pathname.match(/^\/embed\/([a-zA-Z0-9_-]+)/);
      if (embedMatch) return embedMatch[1];
    }
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
  } catch (e) {}
  return null;
}

function timeAgo(unixSeconds) {
  const seconds = Math.floor(Date.now() / 1000 - unixSeconds);
  if (seconds < 60) return 'just now';
  const intervals = [
    [31536000, 'y'], [2592000, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm'],
  ];
  for (const [secs, label] of intervals) {
    const count = Math.floor(seconds / secs);
    if (count >= 1) return `${count}${label} ago`;
  }
  return 'just now';
}

function formatScore(n) {
  if (n == null) return '0';
  if (n >= 100000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// --- Comment HTML sanitizer ---
// Comment bodies are rebuilt from an allowlist: only plain formatting elements
// survive, and the only attributes kept are a safe link or image address.

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

const SAFE_TAGS = new Set([
  'a', 'p', 'br', 'hr', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'strike',
  'sup', 'sub', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div', 'img',
]);

// Removed together with everything inside them. Any other unknown element is
// unwrapped, so its text is kept.
const DROPPED_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'link', 'meta',
  'base', 'head', 'title', 'template', 'noscript', 'svg', 'math', 'video',
  'audio', 'source', 'track', 'canvas',
]);

// http(s) only; site-relative Reddit links become absolute.
function safeUrl(value, httpsOnly) {
  const url = String(value || '').trim();
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `https://www.reddit.com${url}`;
  return (httpsOnly ? /^https:\/\//i : /^https?:\/\//i).test(url) ? url : null;
}

function sanitizeNode(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }

    const tag = child.localName;
    if (child.namespaceURI !== XHTML_NAMESPACE || DROPPED_TAGS.has(tag)) {
      child.remove();
      continue;
    }

    sanitizeNode(child);

    if (!SAFE_TAGS.has(tag)) {
      child.replaceWith(...child.childNodes);
      continue;
    }

    const href = tag === 'a' ? safeUrl(child.getAttribute('href'), false) : null;
    const src = tag === 'img' ? safeUrl(child.getAttribute('src'), true) : null;
    const alt = tag === 'img' ? child.getAttribute('alt') : null;
    for (const attr of [...child.attributes]) child.removeAttribute(attr.name);

    if (tag === 'a') {
      if (href) child.setAttribute('href', href);
      child.setAttribute('target', '_blank');
      child.setAttribute('rel', 'noopener noreferrer');
    } else if (tag === 'img') {
      if (!src) { child.remove(); continue; }
      child.setAttribute('src', src);
      child.setAttribute('alt', alt || '');
      child.setAttribute('loading', 'lazy');
    }
  }
}

// `html` is entity-escaped markup, as Reddit's JSON API returns `body_html`.
// It is decoded exactly once here; callers must not pass raw markup.
function sanitizeHtml(html) {
  if (!html) return '';
  const txt = document.createElement('textarea');
  txt.innerHTML = html;

  const doc = new DOMParser().parseFromString(txt.value, 'text/html');
  sanitizeNode(doc.body);
  return doc.body.innerHTML;
}

// --- Image URL detection ---

const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i;
const IMAGE_HOSTS = [
  /^https?:\/\/(i\.)?imgur\.com\//,
  /^https?:\/\/i\.redd\.it\//,
  /^https?:\/\/preview\.redd\.it\//,
  /^https?:\/\/pbs\.twimg\.com\//,
  /^https?:\/\/media\.giphy\.com\//,
];

function isImageUrl(url) {
  if (!url) return false;
  if (IMAGE_EXTENSIONS.test(url)) return true;
  for (const pattern of IMAGE_HOSTS) {
    if (pattern.test(url)) return true;
  }
  return false;
}

// Normalize imgur URLs to direct image links
function normalizeImageUrl(url) {
  // imgur.com/ABC -> i.imgur.com/ABC.jpg
  const imgurMatch = url.match(/^https?:\/\/imgur\.com\/(\w+)$/);
  if (imgurMatch) return `https://i.imgur.com/${imgurMatch[1]}.jpg`;
  // imgur.com/a/ABC or imgur.com/gallery/ABC - can't easily resolve, skip
  if (/imgur\.com\/(a|gallery)\//.test(url)) return null;
  return url;
}

// Process HTML to auto-expand image links into inline images
function expandImageLinks(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  doc.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href');
    if (!href || !isImageUrl(href)) return;

    const imgUrl = normalizeImageUrl(href);
    if (!imgUrl) return;

    // Don't double-expand if there's already an image inside
    if (a.querySelector('img')) return;

    const wrapper = doc.createElement('div');
    wrapper.className = 'ryt-inline-image';

    const img = doc.createElement('img');
    img.src = imgUrl;
    img.loading = 'lazy';
    img.alt = 'Image';

    wrapper.appendChild(img);
    a.parentNode.insertBefore(wrapper, a.nextSibling);
  });

  return doc.body.innerHTML;
}

// --- Avatar helpers ---

function avatarLetterColor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}
