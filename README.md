# Reddit Comments for YouTube

[![Firefox Add-on](https://img.shields.io/amo/v/reddit-comments-for-youtube?label=Firefox%20Add-on&color=FF4500)](https://addons.mozilla.org/en-US/firefox/addon/reddit-comments-for-youtube/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A clean, privacy-respecting browser extension that shows Reddit discussions on YouTube videos. See what Reddit thinks about the video you're watching.

![Reddit comments embedded on YouTube](screenshots/content-view.png)

<details>
<summary>Popup view</summary>

![Extension popup showing Reddit threads](screenshots/popup-view.png)

</details>

## Install

**[Install for Firefox](https://addons.mozilla.org/en-US/firefox/addon/reddit-comments-for-youtube/)** — from the official Mozilla Add-ons store.

<details>
<summary>Manual / Development install</summary>

### Firefox (temporary)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **"Load Temporary Add-on..."**
3. Select the `manifest.json` file from this directory

### Firefox (development with auto-reload)

```bash
npx web-ext run --firefox=firefox
```

### Chrome

1. Open `chrome://extensions`
2. Enable **"Developer mode"**
3. Click **"Load unpacked"**
4. Select this directory

</details>

## Features

- **Reddit comments on YouTube** — Automatically finds and displays Reddit threads for the video you're watching
- **Smooth toggle** — Switch between Reddit and YouTube comments with a pill-shaped toggle and slide animations
- **Multiple threads** — Horizontal scrolling cards when a video has been posted to multiple subreddits
- **Nested comment trees** — Full threaded comments with collapse/expand, just like Reddit
- **Profile avatars** — Letter avatars load instantly, real Reddit profile pictures lazy-load in the background
- **Inline image previews** — Image links (imgur, i.redd.it, etc.) auto-expand inline
- **Post images** — If the Reddit post is an image post, it's displayed above the comments
- **"Load more" comments** — Expand truncated comment threads
- **Sort comments** — Best, Top, New, Old, Controversial — preference is remembered
- **Awards & flair** — Gilded/awarded comments and user/post flairs are displayed
- **Dark mode** — Automatically matches YouTube's dark/light theme
- **Hyperlinked everything** — Subreddits, usernames, post titles, and permalinks all link to Reddit
- **Works on all YouTube URLs** — `/watch?v=`, `/live/`, `/shorts/`, `/embed/`, and `youtu.be` links

## Privacy

**This extension collects zero data.** No analytics, no tracking, no external server calls, no credential access.

It only communicates with Reddit's public API to search for threads and fetch comments. All requests are read-only and unauthenticated.

## How It Works

1. **Content script** runs on YouTube pages and detects video navigation (handles YouTube's SPA architecture)
2. **Background script** searches Reddit's public API for posts matching the video URL (both `youtube.com/watch?v=` and `youtu.be/` formats)
3. If Reddit threads are found, YouTube comments are replaced with a Reddit comment panel
4. Comments are fetched and rendered as nested trees with all the Reddit metadata (scores, awards, flairs, avatars)

### Architecture

```
manifest.json      → Extension config (Manifest V2, Firefox)
background.js      → Reddit API calls, caching (5min TTL), rate limiting, avatar fetching
content.js         → YouTube SPA detection, UI injection, comment rendering
content.css        → Styles with CSS variables for dark/light mode
popup.html/js/css  → Extension popup showing thread list
utils.js           → Shared utilities (sanitizer, time formatting, image detection)
icons/             → Extension icons (grey default, orange when threads found)
```

No build step. No bundler. No framework. Just plain JavaScript and CSS.

## Why This Exists

The popular "Comet - Reddit Comments on YouTube" extension was found to contain malicious code. Specifically, its background script:

1. Fetches your Reddit session data via `old.reddit.com/api/me.json` with your cookies
2. Sends your entire Reddit profile (username, modhash/session token, email, karma, etc.) to an external server at `45.76.61.40:5000`
3. Runs on extension install and repeats daily via a Chrome alarm

The modhash token allows someone to vote, comment, and take actions **as you** on Reddit. The data is sent over plain HTTP, making it interceptable.

**If you have Comet installed, uninstall it immediately**, log out of all Reddit sessions, and change your password.

This extension was built from scratch as a clean replacement with the same functionality and zero data collection.

## License

MIT
