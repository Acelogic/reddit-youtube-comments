// Content script — Comet-style Reddit comments replacing YouTube comments

(function () {
  'use strict';

  let currentVideoId = null;
  let container = null;
  let commentsObserver = null;
  let activeThreadIdx = 0;
  let cachedPosts = [];
  let currentSort = 'top';
  let currentPostId = null; // for "load more" children

  const SORT_OPTIONS = [
    { value: 'confidence', label: 'Best' },
    { value: 'top', label: 'Top' },
    { value: 'new', label: 'New' },
    { value: 'old', label: 'Old' },
    { value: 'controversial', label: 'Controversial' },
  ];

  const UPVOTE_SVG = `<svg class="ryt-vote-arrow" viewBox="0 0 24 24"><path d="M12 4l-8 8h5v8h6v-8h5z"/></svg>`;
  const DOWNVOTE_SVG = `<svg class="ryt-vote-arrow" viewBox="0 0 24 24"><path d="M12 20l8-8h-5V4H9v8H4z"/></svg>`;

  // Award icons (inline SVG for common awards)
  const AWARD_GOLD = `<span class="ryt-award ryt-award-gold" title="Gold">&#9733;</span>`;
  const AWARD_SILVER = `<span class="ryt-award ryt-award-silver" title="Silver">&#9733;</span>`;
  const AWARD_PLATINUM = `<span class="ryt-award ryt-award-platinum" title="Platinum">&#9733;</span>`;

  // --- Load saved sort preference ---
  try {
    chrome.runtime.sendMessage({ type: 'GET_SORT_PREF' }, result => {
      if (result?.sort) currentSort = result.sort;
    });
  } catch (e) {
    // Extension context may not be ready yet, use default
  }

  // --- YouTube SPA Navigation Detection ---

  function onNavigate() {
    const videoId = extractVideoId(location.href);
    if (videoId === currentVideoId) return;
    currentVideoId = videoId;
    cachedPosts = [];
    activeThreadIdx = 0;

    if (!videoId) { removePanel(); return; }

    waitForComments().then(() => {
      injectPanel(videoId);
    });
  }

  document.addEventListener('yt-navigate-finish', onNavigate);
  document.addEventListener('spfdone', onNavigate);

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; onNavigate(); }
  }, 1000);

  window.addEventListener('popstate', onNavigate);

  // --- Wait for YouTube comments section ---

  function waitForComments() {
    return new Promise(resolve => {
      const existing = document.querySelector('ytd-comments#comments');
      if (existing) { resolve(existing); return; }

      if (commentsObserver) commentsObserver.disconnect();
      commentsObserver = new MutationObserver((_, obs) => {
        const el = document.querySelector('ytd-comments#comments');
        if (el) { obs.disconnect(); resolve(el); }
      });
      commentsObserver.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        if (commentsObserver) commentsObserver.disconnect();
        resolve(document.querySelector('ytd-comments#comments') || null);
      }, 10000);
    });
  }

  // --- Panel injection ---

  function removePanel() {
    if (container) { container.remove(); container = null; }
    showYouTubeComments();
  }

  function showYouTubeComments() {
    const yt = document.querySelector('ytd-comments#comments');
    if (yt) yt.style.display = '';
  }

  function hideYouTubeComments() {
    const yt = document.querySelector('ytd-comments#comments');
    if (yt) yt.style.display = 'none';
  }

  function transitionTo(target) {
    const yt = document.querySelector('ytd-comments#comments');
    const redditContent = container?.querySelector('.ryt-content-wrapper');
    if (!container) return;

    if (target === 'youtube') {
      // Fade out Reddit
      if (redditContent) {
        redditContent.classList.add('ryt-fade-out');
        setTimeout(() => {
          redditContent.style.display = 'none';
          redditContent.classList.remove('ryt-fade-out');
          // Fade in YouTube
          if (yt) {
            yt.style.display = '';
            yt.style.opacity = '0';
            yt.style.transform = 'translateY(10px)';
            yt.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
            requestAnimationFrame(() => {
              yt.style.opacity = '1';
              yt.style.transform = 'translateY(0)';
            });
          }
        }, 200);
      } else {
        if (yt) yt.style.display = '';
      }
    } else {
      // Fade out YouTube
      if (yt) {
        yt.style.opacity = '0';
        yt.style.transform = 'translateY(10px)';
        yt.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        setTimeout(() => {
          yt.style.display = 'none';
          yt.style.opacity = '';
          yt.style.transform = '';
          yt.style.transition = '';
          // Fade in Reddit
          if (redditContent) {
            redditContent.style.display = '';
            redditContent.classList.add('ryt-fade-in');
            setTimeout(() => redditContent.classList.remove('ryt-fade-in'), 300);
          }
        }, 200);
      } else if (redditContent) {
        redditContent.style.display = '';
      }
    }
  }

  function injectPanel(videoId) {
    const old = document.getElementById('ryt-container');
    if (old) old.remove();
    const oldSwitch = document.getElementById('ryt-switch-back');
    if (oldSwitch) oldSwitch.remove();

    const ytComments = document.querySelector('ytd-comments#comments');
    if (!ytComments) return;

    container = document.createElement('div');
    container.id = 'ryt-container';

    const loading = document.createElement('div');
    loading.className = 'ryt-state ryt-loading';
    loading.textContent = 'Searching Reddit...';
    container.appendChild(loading);

    ytComments.parentNode.insertBefore(container, ytComments);

    chrome.runtime.sendMessage({ type: 'SEARCH_VIDEO', videoId }, result => {
      container.innerHTML = '';

      if (!result?.ok || !result.posts.length) {
        // No Reddit threads — show YouTube comments, keep a minimal header with retry
        showYouTubeComments();

        const header = document.createElement('div');
        header.className = 'ryt-header';

        const headerLeft = document.createElement('div');
        headerLeft.className = 'ryt-header-left';
        const title = document.createElement('span');
        title.className = 'ryt-header-title';
        title.textContent = 'Reddit Comments';
        const info = document.createElement('span');
        info.className = 'ryt-header-count';
        info.textContent = 'No threads found';
        headerLeft.appendChild(title);
        headerLeft.appendChild(info);

        const retryBtn = document.createElement('button');
        retryBtn.className = 'ryt-retry-btn';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', () => {
          currentVideoId = null; // force re-search
          onNavigate();
        });

        header.appendChild(headerLeft);
        header.appendChild(retryBtn);
        container.appendChild(header);
        return;
      }

      cachedPosts = result.posts;
      activeThreadIdx = 0;
      hideYouTubeComments();
      renderFullView();
    });
  }

  // --- Full Comet-style view ---

  function renderFullView() {
    container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'ryt-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'ryt-header-left';

    const title = document.createElement('span');
    title.className = 'ryt-header-title';
    title.textContent = 'Reddit Comments';

    const count = document.createElement('span');
    count.className = 'ryt-header-count';
    count.textContent = `${cachedPosts.length} thread${cachedPosts.length !== 1 ? 's' : ''} found`;

    headerLeft.appendChild(title);
    headerLeft.appendChild(count);

    // Toggle button group
    const toggleGroup = document.createElement('div');
    toggleGroup.className = 'ryt-toggle-group';

    const redditToggle = document.createElement('button');
    redditToggle.className = 'ryt-toggle-btn ryt-toggle-active';
    redditToggle.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="10" fill="currentColor"/><circle cx="8.5" cy="10" r="1.5" fill="var(--ryt-bg, #fff)"/><circle cx="15.5" cy="10" r="1.5" fill="var(--ryt-bg, #fff)"/><path d="M8 14.5c0 0 1.5 2 4 2s4-2 4-2" stroke="var(--ryt-bg, #fff)" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg><span>Reddit</span>`;

    const ytToggle = document.createElement('button');
    ytToggle.className = 'ryt-toggle-btn';
    ytToggle.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M23.5 6.2s-.2-1.6-.9-2.3c-.9-.9-1.8-.9-2.3-1C17 2.6 12 2.6 12 2.6s-5 0-8.3.3c-.5.1-1.4.1-2.3 1-.7.7-.9 2.3-.9 2.3S.2 8.1.2 10v1.8c0 1.9.3 3.8.3 3.8s.2 1.6.9 2.3c.9.9 2 .9 2.5 1 1.8.2 7.6.2 7.6.2s5 0 8.3-.3c.5-.1 1.4-.1 2.3-1 .7-.7.9-2.3.9-2.3s.3-1.9.3-3.8V10c0-1.9-.3-3.8-.3-3.8z" fill="currentColor"/><path d="M9.6 15.6V8.4l6.4 3.6-6.4 3.6z" fill="var(--ryt-bg, #fff)"/></svg><span>YouTube</span>`;

    redditToggle.addEventListener('click', () => {
      if (redditToggle.classList.contains('ryt-toggle-active')) return;
      redditToggle.classList.add('ryt-toggle-active');
      ytToggle.classList.remove('ryt-toggle-active');
      transitionTo('reddit');
    });

    ytToggle.addEventListener('click', () => {
      if (ytToggle.classList.contains('ryt-toggle-active')) return;
      ytToggle.classList.add('ryt-toggle-active');
      redditToggle.classList.remove('ryt-toggle-active');
      transitionTo('youtube');
    });

    toggleGroup.appendChild(redditToggle);
    toggleGroup.appendChild(ytToggle);

    header.appendChild(headerLeft);
    header.appendChild(toggleGroup);
    container.appendChild(header);

    // Content wrapper (for transition animations)
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'ryt-content-wrapper';

    // Thread cards (horizontal scroll)
    if (cachedPosts.length > 1) {
      const threads = document.createElement('div');
      threads.className = 'ryt-threads';

      cachedPosts.forEach((post, idx) => {
        const card = document.createElement('div');
        card.className = 'ryt-thread-card' + (idx === activeThreadIdx ? ' ryt-active' : '');

        card.innerHTML = `
          <div class="ryt-thread-sub"><a href="https://www.reddit.com/r/${escapeHtml(post.subreddit)}" target="_blank" rel="noopener noreferrer">r/${escapeHtml(post.subreddit)}</a></div>
          <div class="ryt-thread-title">${escapeHtml(post.title)}</div>
          <div class="ryt-thread-stats">
            <span class="ryt-thread-score">&uarr; ${formatScore(post.score)}</span>
            <span>${post.num_comments} comments</span>
            <span>&middot;</span>
            <span>${timeAgo(post.created_utc)}</span>
          </div>
        `;

        card.addEventListener('click', () => {
          activeThreadIdx = idx;
          renderFullView();
        });

        threads.appendChild(card);
      });

      contentWrapper.appendChild(threads);
    }

    // Active post
    const post = cachedPosts[activeThreadIdx];
    currentPostId = post.id;

    // Post header with image/thumbnail
    const postHeader = document.createElement('div');
    postHeader.className = 'ryt-post-header';

    let postImageHtml = '';
    const postImageUrl = getPostImageUrl(post);
    if (postImageUrl) {
      postImageHtml = `
        <div class="ryt-post-image">
          <img src="${escapeHtml(postImageUrl)}" loading="lazy" alt="Post image">
        </div>
      `;
    }

    // Post flair
    let flairHtml = '';
    if (post.link_flair_text) {
      const flairBg = post.link_flair_background_color || 'var(--ryt-bg-secondary)';
      const flairColor = post.link_flair_text_color === 'light' ? '#fff' : 'var(--ryt-text)';
      flairHtml = `<span class="ryt-flair" style="background:${escapeHtml(flairBg)};color:${flairColor}">${escapeHtml(post.link_flair_text)}</span>`;
    }

    postHeader.innerHTML = `
      <div class="ryt-post-title">
        <a href="https://www.reddit.com${post.permalink}" target="_blank" rel="noopener noreferrer">${escapeHtml(post.title)}</a>
        ${flairHtml}
      </div>
      <div class="ryt-post-meta">
        <a class="ryt-post-sub" href="https://www.reddit.com/r/${escapeHtml(post.subreddit)}" target="_blank" rel="noopener noreferrer">r/${escapeHtml(post.subreddit)}</a>
        <span>&middot;</span>
        <a class="ryt-meta-link" href="https://www.reddit.com/user/${escapeHtml(post.author)}" target="_blank" rel="noopener noreferrer">u/${escapeHtml(post.author)}</a>
        <span>&middot;</span>
        <span>${timeAgo(post.created_utc)}</span>
        <span>&middot;</span>
        <span class="ryt-thread-score">&uarr; ${formatScore(post.score)}</span>
      </div>
      ${postImageHtml}
    `;
    contentWrapper.appendChild(postHeader);

    // Sort dropdown
    const sortBar = document.createElement('div');
    sortBar.className = 'ryt-sort';

    const sortLabel = document.createElement('span');
    sortLabel.className = 'ryt-sort-label';
    sortLabel.textContent = 'Sort by:';

    const sortSelect = document.createElement('select');
    for (const opt of SORT_OPTIONS) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.value === currentSort) option.selected = true;
      sortSelect.appendChild(option);
    }
    sortSelect.addEventListener('change', () => {
      currentSort = sortSelect.value;
      chrome.runtime.sendMessage({ type: 'SET_SORT_PREF', sort: currentSort });
      loadAndRenderComments(post);
    });

    sortBar.appendChild(sortLabel);
    sortBar.appendChild(sortSelect);
    contentWrapper.appendChild(sortBar);

    container.appendChild(contentWrapper);

    loadAndRenderComments(post);
  }

  // --- Post image extraction ---

  function getPostImageUrl(post) {
    // Direct image post
    if (post.post_hint === 'image' && post.url) return post.url;
    // Reddit-hosted preview
    if (post.preview?.images?.[0]?.source?.url) {
      return post.preview.images[0].source.url.replace(/&amp;/g, '&');
    }
    // URL is an image
    if (post.url && isImageUrl(post.url)) return post.url;
    return null;
  }

  // --- Load and render comments ---

  function loadAndRenderComments(post) {
    const wrapper = container.querySelector('.ryt-content-wrapper') || container;
    const existing = wrapper.querySelector('.ryt-comments');
    if (existing) existing.remove();
    const existingState = wrapper.querySelector('.ryt-state');
    if (existingState) existingState.remove();

    const loading = document.createElement('div');
    loading.className = 'ryt-state ryt-loading';
    loading.textContent = 'Loading comments...';
    wrapper.appendChild(loading);

    const permalink = post.permalink.endsWith('/') ? post.permalink.slice(0, -1) : post.permalink;

    chrome.runtime.sendMessage(
      { type: 'FETCH_COMMENTS', permalink, sort: currentSort },
      result => {
        loading.remove();

        if (!result?.ok || !result.comments.length) {
          const empty = document.createElement('div');
          empty.className = 'ryt-state';
          empty.textContent = 'No comments yet.';
          wrapper.appendChild(empty);
          return;
        }

        const commentsEl = document.createElement('div');
        commentsEl.className = 'ryt-comments';

        const opAuthor = post.author;
        for (const item of result.comments) {
          if (item.kind === 't1') {
            commentsEl.appendChild(renderComment(item.data, opAuthor, true));
          } else if (item.kind === 'more') {
            commentsEl.appendChild(renderMoreButton(item.data, opAuthor, true));
          }
        }

        wrapper.appendChild(commentsEl);

        // Lazy-load avatars for visible comments
        loadAvatarsForComments(commentsEl);
      }
    );
  }

  // --- Comment rendering ---

  function renderComment(comment, opAuthor, isRoot) {
    const isDeleted = comment.author === '[deleted]' &&
      (comment.body === '[deleted]' || comment.body === '[removed]');
    const isRemoved = comment.body === '[removed]';

    const el = document.createElement('div');
    el.className = 'ryt-comment ' + (isRoot ? 'ryt-comment-root' : 'ryt-comment-nested');

    if (isDeleted || isRemoved) {
      el.classList.add('ryt-comment-deleted');
    }

    const isOp = comment.author === opAuthor;

    // Header row with avatar
    const header = document.createElement('div');
    header.className = 'ryt-comment-header' + (isOp ? ' ryt-comment-op' : '');

    const avatarEl = createAvatar(comment.author);

    const collapseIcon = document.createElement('span');
    collapseIcon.className = 'ryt-collapse-icon';
    collapseIcon.innerHTML = '&#9660;';

    header.appendChild(collapseIcon);
    header.appendChild(avatarEl);

    // Vote arrows
    const votes = document.createElement('span');
    votes.className = 'ryt-vote-arrows';
    votes.innerHTML = UPVOTE_SVG + DOWNVOTE_SVG;
    header.appendChild(votes);

    // Author
    const authorName = comment.author || '[deleted]';
    if (authorName !== '[deleted]' && authorName !== '[removed]') {
      const authorLink = document.createElement('a');
      authorLink.className = 'ryt-comment-author';
      authorLink.href = `https://www.reddit.com/user/${encodeURIComponent(authorName)}`;
      authorLink.target = '_blank';
      authorLink.rel = 'noopener noreferrer';
      authorLink.textContent = authorName;
      authorLink.addEventListener('click', e => e.stopPropagation());
      header.appendChild(authorLink);
    } else {
      const authorSpan = document.createElement('span');
      authorSpan.className = 'ryt-comment-author';
      authorSpan.textContent = authorName;
      header.appendChild(authorSpan);
    }

    // OP badge
    if (isOp) {
      const opBadge = document.createElement('span');
      opBadge.className = 'ryt-badge ryt-badge-op';
      opBadge.textContent = 'OP';
      header.appendChild(opBadge);
    }

    // User flair
    if (comment.author_flair_text) {
      const flair = document.createElement('span');
      flair.className = 'ryt-user-flair';
      flair.textContent = comment.author_flair_text;
      if (comment.author_flair_background_color) {
        flair.style.background = comment.author_flair_background_color;
        flair.style.color = comment.author_flair_text_color === 'light' ? '#fff' : '#000';
      }
      header.appendChild(flair);
    }

    // Score
    const score = document.createElement('span');
    score.className = 'ryt-comment-score';
    score.textContent = `${formatScore(comment.score)} points`;
    header.appendChild(score);

    // Separator + time
    const sep = document.createElement('span');
    sep.innerHTML = '&middot;';
    header.appendChild(sep);

    const time = document.createElement('span');
    time.textContent = timeAgo(comment.created_utc);
    header.appendChild(time);

    // Awards/gilding
    const awardsHtml = renderAwards(comment);
    if (awardsHtml) {
      const awardsEl = document.createElement('span');
      awardsEl.className = 'ryt-awards';
      awardsEl.innerHTML = awardsHtml;
      header.appendChild(awardsEl);
    }

    header.addEventListener('click', () => {
      el.classList.toggle('ryt-collapsed');
    });

    el.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'ryt-comment-body';
    if (isDeleted) {
      body.innerHTML = '<em class="ryt-deleted-text">[deleted]</em>';
    } else if (isRemoved) {
      body.innerHTML = '<em class="ryt-deleted-text">[removed]</em>';
    } else {
      let html = sanitizeHtml(comment.body_html);
      html = expandImageLinks(html);
      body.innerHTML = html;
    }
    el.appendChild(body);

    // Actions
    if (!isDeleted && !isRemoved) {
      const actions = document.createElement('div');
      actions.className = 'ryt-comment-actions';

      const permalinkA = document.createElement('a');
      permalinkA.className = 'ryt-comment-action';
      permalinkA.href = `https://www.reddit.com${comment.permalink || ''}`;
      permalinkA.target = '_blank';
      permalinkA.rel = 'noopener noreferrer';
      permalinkA.textContent = 'permalink';
      actions.appendChild(permalinkA);

      el.appendChild(actions);
    }

    // Replies
    if (comment.replies && comment.replies.data && comment.replies.data.children) {
      const replies = document.createElement('div');
      replies.className = 'ryt-comment-replies';

      for (const reply of comment.replies.data.children) {
        if (reply.kind === 't1') {
          replies.appendChild(renderComment(reply.data, opAuthor, false));
        } else if (reply.kind === 'more' && reply.data.children?.length) {
          replies.appendChild(renderMoreButton(reply.data, opAuthor, false));
        }
      }

      el.appendChild(replies);
    }

    return el;
  }

  // --- "Load more" button ---

  function renderMoreButton(moreData, opAuthor, isRoot) {
    const btn = document.createElement('button');
    btn.className = 'ryt-load-more';
    const count = moreData.count || moreData.children?.length || 0;
    btn.textContent = `Load ${count} more comment${count !== 1 ? 's' : ''}`;

    btn.addEventListener('click', () => {
      if (!moreData.children?.length) {
        btn.remove();
        return;
      }

      btn.textContent = 'Loading...';
      btn.disabled = true;

      chrome.runtime.sendMessage(
        {
          type: 'FETCH_MORE_CHILDREN',
          linkId: currentPostId,
          children: moreData.children,
          sort: currentSort,
        },
        result => {
          if (!result?.ok || !result.comments?.length) {
            btn.textContent = 'Failed to load. Try again.';
            btn.disabled = false;
            return;
          }

          const frag = document.createDocumentFragment();
          for (const item of result.comments) {
            if (item.kind === 't1') {
              frag.appendChild(renderComment(item.data, opAuthor, isRoot));
            }
          }

          btn.parentNode.insertBefore(frag, btn);
          btn.remove();

          // Load avatars for new comments
          const parentEl = frag.parentNode || container.querySelector('.ryt-comments');
          if (parentEl) loadAvatarsForComments(parentEl);
        }
      );
    });

    return btn;
  }

  // --- Awards rendering ---

  function renderAwards(comment) {
    const parts = [];

    // Gilding (old-style)
    if (comment.gilded) {
      for (let i = 0; i < Math.min(comment.gilded, 5); i++) parts.push(AWARD_GOLD);
    }

    // New-style awards
    if (comment.all_awardings?.length) {
      for (const award of comment.all_awardings.slice(0, 5)) {
        if (award.icon_url) {
          parts.push(`<img class="ryt-award-icon" src="${escapeHtml(award.icon_url)}" alt="${escapeHtml(award.name)}" title="${escapeHtml(award.name)} x${award.count}">`);
        } else {
          // Fallback based on award name
          const name = (award.name || '').toLowerCase();
          if (name.includes('gold')) parts.push(AWARD_GOLD);
          else if (name.includes('silver')) parts.push(AWARD_SILVER);
          else if (name.includes('platinum')) parts.push(AWARD_PLATINUM);
        }
        if (award.count > 1) {
          parts.push(`<span class="ryt-award-count">x${award.count}</span>`);
        }
      }
    }

    return parts.length ? parts.join('') : '';
  }

  // --- Avatar system ---

  function createAvatar(username) {
    const wrapper = document.createElement('span');
    wrapper.className = 'ryt-avatar';

    if (!username || username === '[deleted]') {
      wrapper.innerHTML = `<span class="ryt-avatar-letter" style="background:#787c7e">?</span>`;
      return wrapper;
    }

    const letter = username[0].toUpperCase();
    const color = avatarLetterColor(username);
    wrapper.innerHTML = `<span class="ryt-avatar-letter" style="background:${color}">${escapeHtml(letter)}</span>`;
    wrapper.dataset.username = username;

    return wrapper;
  }

  function loadAvatarsForComments(commentsEl) {
    // Collect unique usernames from visible avatars
    const avatarEls = commentsEl.querySelectorAll('.ryt-avatar[data-username]');
    const usernameMap = new Map(); // username -> [elements]

    avatarEls.forEach(el => {
      const u = el.dataset.username;
      if (!u) return;
      if (!usernameMap.has(u)) usernameMap.set(u, []);
      usernameMap.get(u).push(el);
    });

    const usernames = [...usernameMap.keys()];
    if (!usernames.length) return;

    // Fetch in batches
    fetchAvatarBatch(usernames, usernameMap);
  }

  function fetchAvatarBatch(usernames, usernameMap) {
    if (!usernames.length) return;

    chrome.runtime.sendMessage(
      { type: 'FETCH_AVATARS', usernames: usernames.slice(0, 10) },
      result => {
        if (!result?.ok) return;

        // Update DOM with real avatars
        for (const [username, url] of Object.entries(result.avatars)) {
          if (!url) continue;
          const elements = usernameMap.get(username) || [];
          elements.forEach(el => {
            const img = document.createElement('img');
            img.className = 'ryt-avatar-img';
            img.src = url;
            img.alt = username;
            img.addEventListener('error', () => {
              // Fallback to letter avatar on load error
              const letter = username[0].toUpperCase();
              const color = avatarLetterColor(username);
              el.innerHTML = '';
              const span = document.createElement('span');
              span.className = 'ryt-avatar-letter';
              span.style.background = color;
              span.textContent = letter;
              el.appendChild(span);
            });
            el.innerHTML = '';
            el.appendChild(img);
          });
        }

        // Fetch remaining
        if (result.remaining?.length) {
          setTimeout(() => fetchAvatarBatch(result.remaining, usernameMap), 500);
        }
      }
    );
  }

  // --- Helpers ---

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // Initial run
  onNavigate();
})();
