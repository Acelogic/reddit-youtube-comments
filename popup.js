// Popup script — shows Reddit threads for current YouTube video

const $loading = document.getElementById('loading');
const $empty = document.getElementById('empty');
const $notVideo = document.getElementById('not-video');
const $error = document.getElementById('error');
const $threads = document.getElementById('threads');
const $settingsToggle = document.getElementById('settings-toggle');
const $settingsPanel = document.getElementById('settings-panel');
const $threadLayout = document.getElementById('thread-layout');
const $showPostThumbnail = document.getElementById('show-post-thumbnail');
const $combineComments = document.getElementById('combine-comments');
const $parentCommentLimit = document.getElementById('parent-comment-limit');
const $settingsStatus = document.getElementById('settings-status');

const DEFAULT_SETTINGS = {
  threadLayout: 'cards',
  showPostThumbnail: true,
  combineComments: false,
  parentCommentLimit: 0,
};

let statusTimer = null;

function showSettingsStatus(message) {
  $settingsStatus.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    $settingsStatus.textContent = '';
  }, 1600);
}

function saveSetting(key, value) {
  chrome.storage.local.set({ [key]: value }, () => {
    showSettingsStatus('Saved — open YouTube tabs update automatically.');
  });
}

$settingsToggle.addEventListener('click', () => {
  const willOpen = $settingsPanel.classList.contains('hidden');
  $settingsPanel.classList.toggle('hidden', !willOpen);
  $settingsToggle.setAttribute('aria-expanded', String(willOpen));
  $settingsToggle.classList.toggle('active', willOpen);
});

$threadLayout.addEventListener('change', () => {
  saveSetting('threadLayout', $threadLayout.value);
});

$showPostThumbnail.addEventListener('change', () => {
  saveSetting('showPostThumbnail', $showPostThumbnail.checked);
});

$combineComments.addEventListener('change', () => {
  saveSetting('combineComments', $combineComments.checked);
});

$parentCommentLimit.addEventListener('change', () => {
  saveSetting('parentCommentLimit', Number.parseInt($parentCommentLimit.value, 10) || 0);
});

chrome.storage.local.get(DEFAULT_SETTINGS, stored => {
  $threadLayout.value = stored.threadLayout === 'list' ? 'list' : 'cards';
  $showPostThumbnail.checked = stored.showPostThumbnail !== false;
  $combineComments.checked = stored.combineComments === true;

  const commentLimit = String(Number.parseInt(stored.parentCommentLimit, 10) || 0);
  $parentCommentLimit.value = [...$parentCommentLimit.options]
    .some(option => option.value === commentLimit) ? commentLimit : '0';
});

function showState(el) {
  [$loading, $empty, $notVideo, $error].forEach(s => s.classList.add('hidden'));
  $threads.innerHTML = '';
  if (el) el.classList.remove('hidden');
}

function renderThreads(posts) {
  if (!posts.length) {
    showState($empty);
    return;
  }

  showState(null);
  $threads.innerHTML = '';

  for (const post of posts) {
    const link = document.createElement('a');
    link.className = 'thread';
    link.href = `https://www.reddit.com${post.permalink}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';

    link.innerHTML = `
      <div class="thread-meta">
        <span class="thread-sub">r/${escapeHtml(post.subreddit)}</span>
        <span>&middot;</span>
        <span>${timeAgo(post.created_utc)}</span>
      </div>
      <div class="thread-title">${escapeHtml(post.title)}</div>
      <div class="thread-stats">
        <span class="thread-score">&uarr; ${formatScore(post.score)}</span>
        <span class="thread-comments">${post.num_comments} comments</span>
      </div>
    `;

    $threads.appendChild(link);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Init: get current tab's video ID and search Reddit
chrome.runtime.sendMessage({ type: 'GET_VIDEO_ID' }, response => {
  if (!response?.videoId) {
    showState($notVideo);
    return;
  }

  chrome.runtime.sendMessage({ type: 'SEARCH_VIDEO', videoId: response.videoId }, result => {
    if (!result?.ok) {
      showState($error);
      return;
    }
    renderThreads(result.posts);
  });
});
