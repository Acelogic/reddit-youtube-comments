// Popup script — shows Reddit threads for current YouTube video

const $loading = document.getElementById('loading');
const $empty = document.getElementById('empty');
const $notVideo = document.getElementById('not-video');
const $error = document.getElementById('error');
const $threads = document.getElementById('threads');
const $signinNotice = document.getElementById('signin-notice');
const $settingsToggle = document.getElementById('settings-toggle');
const $settingsPanel = document.getElementById('settings-panel');
const $threadLayout = document.getElementById('thread-layout');
const $showPostThumbnail = document.getElementById('show-post-thumbnail');
const $combineComments = document.getElementById('combine-comments');
const $parentCommentLimit = document.getElementById('parent-comment-limit');
const $settingsStatus = document.getElementById('settings-status');

const $hiddenForm = document.getElementById('hidden-subreddit-form');
const $hiddenInput = document.getElementById('hidden-subreddit-input');
const $hiddenMessage = document.getElementById('hidden-subreddit-message');
const $hiddenList = document.getElementById('hidden-subreddit-list');
const $hiddenNote = document.getElementById('hidden-note');

const DEFAULT_SETTINGS = {
  threadLayout: 'cards',
  showPostThumbnail: true,
  combineComments: false,
  parentCommentLimit: 0,
  hiddenSubreddits: [],
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

// --- Hidden subreddits: one validated name per chip ---

let hiddenSubreddits = [];

function showHiddenMessage(text, isError = false) {
  $hiddenMessage.textContent = text;
  $hiddenMessage.classList.toggle('error', isError);
}

function renderHiddenSubreddits() {
  $hiddenList.textContent = '';
  for (const name of hiddenSubreddits) {
    const chip = document.createElement('li');
    chip.className = 'chip';

    const label = document.createElement('span');
    label.className = 'chip-name';
    label.textContent = `r/${name}`;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Show r/${name} again`;
    remove.setAttribute('aria-label', `Show r/${name} again`);
    remove.addEventListener('click', () => {
      saveHiddenSubreddits(hiddenSubreddits.filter(n => n !== name), `r/${name} is shown again.`);
    });

    chip.appendChild(label);
    chip.appendChild(remove);
    $hiddenList.appendChild(chip);
  }
}

function saveHiddenSubreddits(names, message) {
  hiddenSubreddits = names;
  renderHiddenSubreddits();
  chrome.storage.local.set({ hiddenSubreddits: names }, () => {
    showHiddenMessage(message);
    loadThreads();
  });
}

$hiddenForm.addEventListener('submit', event => {
  event.preventDefault();
  const typed = $hiddenInput.value.trim();
  if (!typed) return;

  // One name per entry. Anything ambiguous is refused, never guessed at.
  const name = parseSubredditName(typed);
  if (!name) {
    showHiddenMessage('Enter one subreddit name, like videos. Letters, numbers and underscores only.', true);
    $hiddenInput.select();
    return;
  }

  $hiddenInput.value = '';
  if (hiddenSubreddits.includes(name)) {
    showHiddenMessage(`r/${name} is already hidden.`);
    return;
  }
  saveHiddenSubreddits([...hiddenSubreddits, name], `Hiding r/${name}.`);
});

$hiddenInput.addEventListener('input', () => showHiddenMessage(''));

// Keep the chips in step when a YouTube tab's "Hide r/…" button changes the list.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.hiddenSubreddits) return;
  const next = parseSubredditList((changes.hiddenSubreddits.newValue || []).join(' '));
  if (next.join(' ') === hiddenSubreddits.join(' ')) return;
  hiddenSubreddits = next;
  renderHiddenSubreddits();
});

chrome.storage.local.get(DEFAULT_SETTINGS, stored => {
  $threadLayout.value = stored.threadLayout === 'list' ? 'list' : 'cards';
  $showPostThumbnail.checked = stored.showPostThumbnail !== false;
  $combineComments.checked = stored.combineComments === true;

  const commentLimit = String(Number.parseInt(stored.parentCommentLimit, 10) || 0);
  $parentCommentLimit.value = [...$parentCommentLimit.options]
    .some(option => option.value === commentLimit) ? commentLimit : '0';

  hiddenSubreddits = parseSubredditList(
    Array.isArray(stored.hiddenSubreddits) ? stored.hiddenSubreddits.join(' ') : ''
  );
  renderHiddenSubreddits();
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

// Get the current tab's video ID and search Reddit. Runs when the popup opens
// and again whenever the hidden-subreddit list changes.
function loadThreads() {
  chrome.runtime.sendMessage({ type: 'GET_VIDEO_ID' }, response => {
    $hiddenNote.classList.add('hidden');
    if (!response?.videoId) {
      showState($notVideo);
      return;
    }

    chrome.runtime.sendMessage({ type: 'SEARCH_VIDEO', videoId: response.videoId }, result => {
      // Reddit asked for a login: say so instead of a generic failure.
      $signinNotice.classList.toggle('hidden', result?.signedOut !== true);
      if (!result?.ok) {
        showState(result?.signedOut ? null : $error);
        return;
      }
      renderThreads(result.posts);

      const hiddenCount = result.hiddenCount || 0;
      $hiddenNote.textContent = hiddenCount
        ? `${hiddenCount} thread${hiddenCount !== 1 ? 's' : ''} hidden by your subreddit filter.`
        : '';
      $hiddenNote.classList.toggle('hidden', !hiddenCount);
    });
  });
}

loadThreads();
