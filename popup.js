// Popup script — shows Reddit threads for current YouTube video

const $loading = document.getElementById('loading');
const $empty = document.getElementById('empty');
const $notVideo = document.getElementById('not-video');
const $error = document.getElementById('error');
const $threads = document.getElementById('threads');

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
