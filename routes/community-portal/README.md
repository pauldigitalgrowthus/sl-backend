# Community Portal API

Implements the SL Community Portal Scope of Work inside the existing `Sl-Music-Backend`
codebase, following the same conventions as `Educator-Portal` / `Royalty-Portal`
(Express Router per sub-module, `getMySQLConnection()` + `mysql2/promise`, `successResponse` /
`errorResponse` helpers, `auth` middleware for protected routes).

Mounted at: **`/api/community-portal`** (see `server.js`)

## What was added elsewhere (required for this module to run)

- `config/mysql.js` → `createCommunityPortalTables()` creates all `cp_*` tables and is called
  from `initializeTables()`, same as every other portal in this codebase. A default
  `Global Community` channel (`slug: global-community`) is seeded automatically.
- `config/s3.js` → `communityPortalUpload` (multer-s3 config, JPEG/PNG/GIF/WebP, 8MB, up to
  6 files) is used for post/thread images, group covers, and message attachments.
- `server.js` → `app.use('/api/community-portal', communityPortalRoutes)`.

## Folder structure

```
routes/community-portal/
  main.js               → mounts every sub-router below
  helpers.js             → shared pagination, moderator check, JSON parsing, channel/group access checks
  feed.js                 /feed                 → Community Feed (Module 1)
  discussions.js           /discussions           → Discussions (Module 2)
  groups.js                 /groups                 → Groups (Module 3)
  messaging.js               /messages                → Private Messaging (Module 4)
  channels.js                 /channels                 → Channels & Segmented Access (Module 5)
  prayer-intentions.js         /prayer-intentions         → Prayer Intentions Thread (Module 6)
  moderation.js                 /moderation                 → Moderation & Administration (Module 8)
```

Module 7 (User Roles & Profiles) is intentionally **not duplicated** here — it reuses the
existing `users.role` / `users.user_type` / `is_composer` / `is_diocesan` fields and the
existing `routes/Roles-Permissions` module. `isCommunityModerator()` in `helpers.js` treats
`role = 'sl_team'` or `user_type = 'superadmin'` as community Admin.

## Endpoints (all JSON, all wrapped in `{ success, message, data }`)

### Feed — `/api/community-portal/feed`
| Method | Route | Access | Notes |
|---|---|---|---|
| GET | `/` | Public | `?channel_id&group_id&page&limit` |
| GET | `/:id` | Public | |
| POST | `/` | Private | multipart, `images[]` up to 6; supports `linked_product_type` (`music_publication`\|`course`) + `linked_product_id/title/url` for "Post Music Products and Academy Courses" |
| PUT | `/:id` | Author | |
| DELETE | `/:id` | Author / group mod / Admin | soft delete |
| POST | `/:id/like` | Private | toggles like |
| GET | `/:id/comments` | Public | |
| POST | `/:id/comments` | Private | |
| PUT/DELETE | `/comments/:commentId` | Author / Admin | |

### Discussions — `/api/community-portal/discussions`
Threads with `title`, `body`, `category`, `?sort=latest|popular|unanswered`, pin/lock
(`POST /:id/pin`, `POST /:id/lock`), replies (`/:id/replies`, `/replies/:replyId`).

### Groups — `/api/community-portal/groups`
Public & private groups, `group_type` = `diocesan|parish|composer|interest|general`.
Join flow: public groups auto-activate, private groups create a `pending` membership that an
owner/moderator approves via `POST /:id/members/:userId/approve`. Member roles: `owner`,
`moderator`, `member`. `DELETE /:id/members/:userId?ban=true` bans instead of just removing.

### Private Messaging — `/api/community-portal/messages`
`POST /conversations` with `{ recipient_id }` for 1-to-1, or `{ title, participant_ids }` for
group chat. `GET /conversations` returns last message + unread count per conversation.
`GET/POST /conversations/:id/messages` for history/sending (multipart `attachments[]`).

### Channels — `/api/community-portal/channels`
`channel_type` = `global|private|composer|parish|diocesan|group`. Access is resolved in
`helpers.canAccessChannel()`: global is open to everyone, composer/diocesan auto-admit based
on the user's `is_composer` / `is_diocesan` flag, group-linked channels check group
membership, and everything else falls back to `allowed_roles` (JSON array) or an explicit row
in `cp_channel_members`. Only Admin / SL Team can create/update/delete channels or manage
private-channel membership.

### Prayer Intentions — `/api/community-portal/prayer-intentions`
`POST /` to post a request (`is_anonymous` supported), `POST /:id/pray` toggles "praying for
this", `POST /:id/responses` for community support replies, `PUT /:id` to move status through
`ongoing → answered → closed`.

### Moderation & Administration — `/api/community-portal/moderation`
- `POST /report` — any signed-in member can flag a post/comment/thread/reply/prayer/group/message.
- Everything else (`GET /reports`, `PUT /reports/:id`, `POST /content/hide`,
  `POST /content/restore`, `DELETE /content`, `GET /summary`) is Admin / SL Team only.

## Real-time (Socket.IO)

`routes/community-portal/socket.js` adds a Socket.IO server on top of the same HTTP server /
port as the REST API (see `server.js` — `http.createServer(app)` + `initSocket(httpServer)`).
This is purely additive: every REST endpoint above still works exactly the same (tested via
Postman) whether or not any socket is connected — all emit calls go through a safe helper that
silently no-ops if the socket layer isn't initialized.

**Package added:** `socket.io` (see `package.json`) — run `npm install` after pulling this
branch.

### Connecting (frontend)
```js
import { io } from "socket.io-client";

const socket = io("http://localhost:5000", {
  path: "/socket.io",
  auth: { token: jwtToken } // same JWT used for the Authorization header on REST calls
});
```
Connections are authenticated with the same JWT as the REST API (`middleware/auth.js`). An
invalid/missing token rejects the connection with an `Error` on `connect_error`.

### Rooms (join what you're currently viewing)
| Emit (client → server) | Room joined | When to use |
|---|---|---|
| `join_feed` / `leave_feed` | `feed:global` | Viewing the main community feed / discussions list (no channel or group filter) |
| `join_channel` (channelId) | `channel:{id}` | Viewing a specific channel's feed/discussions |
| `join_group` (groupId) | `group:{id}` | Viewing a specific group's feed/discussions/members |
| `join_conversation` (conversationId) | `conversation:{id}` | Chat screen for that conversation is open |
| `join_prayer_wall` / `leave_prayer_wall` | `prayer:global` | Viewing the Prayer Intentions wall |
| `join_moderation` | `moderation:global` | Admin/SL Team dashboard (server checks role before allowing the join) |

Every connected user is also auto-joined to a personal room `user:{their_id}` for direct
notices (DM pings, group join approvals, moderation broadcasts).

### Events (server → client)
| Event | Fired when | Payload |
|---|---|---|
| `new_post` | Someone creates a feed post | `{ post }` |
| `new_comment` | Someone comments on a post | `{ post_id, comment }` |
| `post_like_updated` | A post is liked/unliked | `{ post_id, like_count, liked, user_id }` |
| `new_thread` | New discussion thread created | `{ thread }` |
| `new_reply` | New reply on a thread | `{ thread_id, reply }` |
| `thread_pinned` / `thread_locked` | Thread pin/lock toggled | `{ thread_id, is_pinned }` / `{ thread_id, is_locked }` |
| `new_message` | New message in a conversation (to `conversation:{id}` room) | `{ conversation_id, message }` |
| `conversation_updated` | New message, sent to each *other* participant's personal room (for list/unread refresh even if the chat isn't open) | `{ conversation_id, last_message }` |
| `conversation_created` | You were added to a new direct/group conversation | `{ conversation }` |
| `new_prayer_request` / `new_prayer_response` | Prayer wall activity (`prayer:global`) | `{ prayer_intention }` / `{ prayer_id, response }` |
| `prayer_count_updated` | "Praying for this" toggled | `{ prayer_id, pray_count }` |
| `group_member_joined` | Someone joins/gets approved into a group (`group:{id}`) | `{ group_id, user_id }` |
| `group_join_approved` | Your pending join request was approved (personal room) | `{ group_id }` |
| `new_report` / `content_moderated` | Moderation activity (`moderation:global`, Admin/SL Team only) | `{ report }` / `{ content_type, content_id, action }` |

`new_post` / `new_comment` / `new_thread` / `new_reply` / `thread_pinned` / `thread_locked` are
routed to `channel:{id}` if the content has a `channel_id`, else `group:{id}` if it has a
`group_id`, else `feed:global` — join whichever room matches what the user is looking at.

## Not covered here (flagged in the SOW review, still open)

- Role → permission matrix (who can post/comment/moderate per role) — currently a simple
  "author, group moderator/owner, or platform Admin" model; a fine-grained matrix should be
  layered on via `routes/Roles-Permissions` if the client needs it.
- Real-time is now live for feed/discussions/messaging/prayer-intentions/moderation via
  Socket.IO (see above) — still open: push notifications (mobile) and email notifications for
  offline users.
- Push/email notifications on new messages, replies, or prayer responses — can hook into the
  existing `utils/notificationUtils.js` / `utils/SendMailer.js` if needed.
