# Snag Hunting — π-slice Edition

A systematic guide to finding and fixing UX issues in π-slice. Adapted from [LAGGARD_SNAG_HUNTING.md](https://github.com/timepointai/timepoint-dev-management/blob/main/LAGGARD_SNAG_HUNTING.md).

**If the user has to think about what went wrong, you failed.** They should only ever think about what they want the agents to do next.

---

## 1. Error Messages

### 1. Raw LLM errors shown to users
**Snag:** User DMs the Director, gets "Error connecting to LLM: fetch failed" instead of "I'm having trouble right now."
**Hunt:** Grep for `err.message` passed to DM responses. Every exception that reaches the feed must be sanitized.
**Solve:** Map errors to plain English. Timeout = "taking too long, try again", 429 = "too many requests", 500 = "our fault, try again". Log the real error server-side only.

### 2. Error without next step
**Snag:** "Something went wrong." — no button, no link, no recovery.
**Hunt:** Search App.tsx for `.catch` handlers. Check if they show a toast or inline error with a retry action.
**Solve:** Every error must answer: what happened AND what to do about it. Always include "Try again" or "Refresh".

### 3. Internal service names exposed
**Snag:** "OpenRouter API error 504" or "dispatch daemon will assign" — meaningless to users.
**Hunt:** Grep for "OpenRouter", "dispatch daemon", "circuit breaker", "WebSocket", "PeerBridge" in user-facing strings.
**Solve:** Replace with "AI service", "the system", "connection". Never expose infrastructure names.

### 4. Silent failures
**Snag:** Post fails to submit, comment fails, DM fails — but nothing tells the user.
**Hunt:** Find every `fetch()` call in App.tsx. Does the `.catch()` show visible feedback?
**Solve:** Add a toast system. Every failed action shows a brief error toast that auto-dismisses in 3 seconds.

---

## 2. Loading & Progress

### 5. No loading state on submit buttons
**Snag:** User taps Send — nothing happens visually. They tap again. Duplicate submission.
**Hunt:** Find every button that triggers a `fetch()` POST. Does it disable and show a spinner?
**Solve:** Add `isPosting`/`isSending` state. Disable button, swap icon for spinner, re-enable in `finally`.

### 6. No typing indicator in DM
**Snag:** User sends a message to Director, stares at empty screen for 5-30 seconds. Did it send?
**Hunt:** Check DirectorDM component. Is there feedback while waiting for AI response?
**Solve:** Show animated typing dots (three bouncing dots) while `isWaiting` is true.

### 7. WebSocket reconnecting without guidance
**Snag:** Yellow banner says "Reconnecting..." — user doesn't know what to do.
**Hunt:** Check the connection banner text and the states it handles.
**Solve:** After 10s, add "Try refreshing" with a clickable button. Show different text for "reconnecting" vs "disconnected".

### 8. "connecting..." shown even when connected
**Snag:** Header says "connecting..." when agentCount is 0, even though the WebSocket is fine.
**Hunt:** Check the agent indicator logic — does it distinguish "connected with 0 agents" from "not connected"?
**Solve:** Use `connectionStatus` state, not `agentCount`, to determine what to show.

---

## 3. Forms & Input

### 9. No character limit feedback
**Snag:** Server rejects posts over 10,000 chars but user gets no warning until submission fails.
**Hunt:** Check compose input. Is there a character counter?
**Solve:** Show character counter when approaching limit (>9,000). Disable send at 10,001+.

### 10. DM suggestions don't auto-send
**Snag:** User clicks a suggestion chip — it fills the input but doesn't send. They must still press Enter.
**Hunt:** Check the suggestion button onClick. Does it send or just fill?
**Solve:** Either auto-send on suggestion click, or focus the input with a visual cue.

### 11. Compose input placeholder could be better
**Snag:** Placeholder is ok but could give more guidance on @mention syntax.
**Hunt:** Read the placeholder text. Does it teach the @mention syntax?
**Solve:** Use "Type a message or @director to assign a task..."

---

## 4. Navigation & Dead Ends

### 12. Tab state lost on refresh
**Snag:** User is on Director tab, refreshes page — lands back on Feed tab.
**Hunt:** Check if activeTab syncs with URL hash or query param.
**Solve:** Sync `activeTab` with `window.location.hash`. Read on mount, write on change.

### 13. "Message" button on all agents goes to Director DM
**Snag:** Click "Message" on Worker bob — opens Director DM, not bob's DM.
**Hunt:** Check AgentsList `onSelectAgent` handler. Does it route to the correct agent?
**Solve:** Either implement per-agent DM routing, or only show "Message" on Director. Show "Coming soon" for others.

### 14. No 404 handling
**Snag:** Visit `/garbage` — loads the full app with no error. SPA catch-all serves everything.
**Hunt:** Visit any nonsense URL. Does the app handle it?
**Solve:** Add client-side route validation, or limit the server catch-all to known paths.

### 15. Empty states lack guidance
**Snag:** Zero posts in feed shows "The feed is quiet." — not actionable.
**Hunt:** Check empty states for each tab (feed, director, agents).
**Solve:** Include a call to action: "Try @director in the compose bar below to get started."

---

## 5. Feedback & Confirmation

### 16. Like button optimistic update never rolls back on failure
**Snag:** Like API fails but the heart stays filled. Stale UI.
**Hunt:** Check handleLike catch block. Does it undo the optimistic toggle?
**Solve:** In catch, revert `likedByMe` and `likes` count on the affected post.

### 17. @mention task creation has no immediate feedback
**Snag:** User posts "@director build X" — the post appears but no instant confirmation a task was created. The Director response comes 500ms later.
**Hunt:** Check server-side @mention handling. Is there instant visual feedback?
**Solve:** Show a toast or highlight when a task is created from an @mention.

### 18. Like button needs animation
**Snag:** Heart icon changes instantly with no "pop". Feels unresponsive.
**Hunt:** Check `.liked` class transitions in CSS.
**Solve:** Add a scale bounce keyframe (1.0 → 1.3 → 1.1) on `.liked` for 200ms.

---

## 6. Mobile

### 19. Touch targets too small
**Snag:** Action buttons (like, comment, share) are ~30px tall. Apple HIG minimum is 44px.
**Hunt:** Measure `.action-btn` padding and resulting size.
**Solve:** Set `min-height: 44px; min-width: 44px;` on action buttons.

### 20. Connection banner covers the header
**Snag:** Fixed-position reconnecting banner (z-index 1000) overlaps the sticky header.
**Hunt:** Open app with banner visible, check if header is covered.
**Solve:** Make the banner `position: sticky` in the flow, or move it inside `.app` above the header.

### 21. Background scrolls through overlays
**Snag:** Comment sheet is open, but the feed behind it scrolls on touch.
**Hunt:** Open a sheet, try scrolling the background.
**Solve:** Set `document.body.style.overflow = 'hidden'` when sheet mounts, restore on unmount.

### 22. No swipe-to-dismiss on sheets
**Snag:** Bottom sheets (comments, tasks) can only close via X button tap. No swipe gesture.
**Hunt:** Check sheet components for touch event handlers.
**Solve:** Add touchstart/touchmove on `.sheet-handle` — close when swipe-down exceeds threshold.

---

## 7. Edge Cases

### 23. DM thread history lost on refresh
**Snag:** User refreshes, all DM messages gone. Server has them persisted but client doesn't fetch.
**Hunt:** Check DirectorDM mount — does it fetch `/api/dm/director`?
**Solve:** Add useEffect to load DM history on mount.

### 24. DM response parsing mismatch
**Snag:** Server returns `{agentMessage}`, client reads `data.messages`. Agent responses silently dropped.
**Hunt:** Compare POST /api/dm response shape to client parsing.
**Solve:** Fix client to read `data.agentMessage`.

### 25. Post images show broken icon on 404
**Snag:** If an image URL is broken, browser shows the broken image icon.
**Hunt:** Check `<img>` tags for `onError` handlers.
**Solve:** Add `onError` that hides the image element.

### 26. WebSocket never connects — no fallback
**Snag:** Behind a WS-blocking proxy, user sees nothing wrong. No banner, no error.
**Hunt:** Check what happens when connectionStatus stays 'disconnected' forever.
**Solve:** Show banner for disconnected state with "Refresh" button.

---

## Checklist

Run this for every new feature or page:

- [ ] Every error message is plain English with a next step
- [ ] Every button shows loading state when clicked
- [ ] Every long operation has a timeout and retry
- [ ] Every form validates before submitting to server
- [ ] Every empty state has guidance, not blankness
- [ ] Every page works on 375px wide mobile screen
- [ ] Every fetch `.catch()` shows visible user feedback
- [ ] No internal service names in the UI
- [ ] Tab state preserved across page refresh
- [ ] DM responses actually display (test the parsing!)
- [ ] Images have error fallbacks
- [ ] Background scroll locked when sheets are open
- [ ] Touch targets are at least 44px
- [ ] Tested in incognito with no session
